import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CaseStatus } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';
import { daysBetween, today } from '../deadline/business-calendar';
import { DeadlineService } from '../deadline/deadline.service';

export interface FileAppealInput {
  readonly forumCode: string;
  readonly groundsSummary: string;
  readonly disputedAmount?: string;
  readonly externalReference?: string;
  readonly filedBy?: 'TAXPAYER' | 'AUTHORITY';
  readonly filedOn?: string;
  readonly collectionStayed?: boolean;
}

export interface HearingInput {
  readonly scheduledFor: string;
  readonly venue?: string;
  readonly representative?: string;
}

export interface HearingOutcomeInput {
  readonly outcome: 'HELD' | 'ADJOURNED' | 'VACATED';
  readonly notes?: string;
  readonly adjournedTo?: string;
}

export interface AppealOutcomeInput {
  readonly outcome: 'UPHELD' | 'VARIED' | 'SET_ASIDE' | 'REMANDED';
  readonly reason: string;
  readonly decidedOn?: string;
  readonly externalReference?: string;
}

/**
 * Appeals to a tribunal or court.
 *
 * Plan reference: V2 sections 13.5 to 13.7 (Phase 6, stage 12).
 *
 * ## The authority does not decide an appeal
 *
 * Every other decision in this system is the authority's own. An appeal is
 * not: a forum outside the authority decides it, and the platform's job is to
 * record what that forum held and then give effect to it. So there is no
 * "approve" here, only `recordOutcome`, and the officer recording it is
 * transcribing rather than deciding.
 *
 * That is why the forum is master data rather than an enum, and why an
 * external reference is captured: the forum's own case number is how the two
 * records are reconciled.
 *
 * ## Why implementation is tracked separately from the outcome
 *
 * An appeal that is won and never implemented is the failure that matters: the
 * taxpayer holds a judgment and the register still shows the old figure.
 * Recording the outcome and giving effect to it are two acts, and the gap
 * between them is something a supervisor needs to be able to see.
 */
@Injectable()
export class AppealService {
  private readonly logger = new Logger(AppealService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly deadlines: DeadlineService,
  ) {}

  async file(
    caseId: number,
    input: FileAppealInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const assessmentCase = await this.cases.findById(caseId);

    if (assessmentCase.statusCode !== CaseStatus.OBJECTION_REJECTED) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. An appeal lies ` +
          'against a decided objection; the objection stage must run first.',
      );
    }

    await this.assertForumExists(assessmentCase.jurisdictionCode, input.forumCode);

    const filedOn = input.filedOn ?? today();
    const { deadlineOn, daysLate } = await this.lateness(caseId, filedOn);

    const objection = await this.latestObjection(caseId);

    return this.sequelize.transaction(async (transaction) => {
      const sequence = await this.nextSequence(caseId, transaction);
      const appealNumber = `${assessmentCase.caseNumber}-APP-${String(sequence).padStart(2, '0')}`;

      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_appeal
                (case_id, objection_id, appeal_number, forum_code, external_reference,
                 filed_on, filed_by, was_in_time, deadline_on, days_late,
                 grounds_summary, disputed_amount, currency_code, collection_stayed, status,
                 created_at, created_by, updated_at, updated_by, is_active)
         VALUES (:caseId, :objectionId, :appealNumber, :forumCode, :externalReference,
                 :filedOn::date, :filedBy, :inTime, :deadlineOn::date, :daysLate,
                 :summary, :disputed, :currency, :stayed, 'FILED',
                 CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId,
            objectionId: objection === undefined ? null : Number(objection['id']),
            appealNumber,
            forumCode: input.forumCode,
            externalReference: input.externalReference ?? null,
            filedOn,
            filedBy: input.filedBy ?? 'TAXPAYER',
            inTime: daysLate === 0,
            deadlineOn,
            daysLate,
            summary: input.groundsSummary,
            disputed:
              input.disputedAmount === undefined
                ? null
                : Money.of(input.disputedAmount, assessmentCase.currencyCode).toDatabaseValue(),
            currency: input.disputedAmount === undefined ? null : assessmentCase.currencyCode,
            stayed: input.collectionStayed ?? false,
            userId: caller.userId ?? null,
          },
        },
      );

      await this.deadlines.satisfy(caseId, 'APPEAL');
      await this.cases.transition(caseId, 'FILE_APPEAL', caller, {
        appealNumber,
        forumCode: input.forumCode,
        daysLate,
      });

      this.logger.log(
        `Appeal ${appealNumber} filed to ${input.forumCode}` +
          (daysLate > 0 ? ` (${daysLate} days out of time)` : ''),
      );
      return rows[0]!;
    });
  }

  /** List a hearing. */
  async listHearing(
    uuid: string,
    input: HearingInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const appeal = await this.findRow(uuid);

    if (appeal['status'] === 'DECIDED' || appeal['status'] === 'WITHDRAWN') {
      throw new ConflictException(
        `Appeal ${String(appeal['appeal_number'])} is ${String(appeal['status'])}; there is ` +
          'nothing left to hear.',
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO tax.tax_appeal_hearing
              (appeal_id, scheduled_for, venue, representative,
               created_at, created_by, updated_at, is_active)
       VALUES (:appealId, :scheduledFor::timestamptz, :venue, :representative,
               CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, true)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          appealId: Number(appeal['id']),
          scheduledFor: input.scheduledFor,
          venue: input.venue ?? null,
          representative: input.representative ?? null,
          userId: caller.userId ?? null,
        },
      },
    );

    await this.sequelize.query(
      `UPDATE tax.tax_appeal SET status = 'LISTED', updated_at = CURRENT_TIMESTAMP
        WHERE id = :id AND status = 'FILED'`,
      { type: QueryTypes.UPDATE, replacements: { id: Number(appeal['id']) } },
    );

    return rows[0]!;
  }

  async recordHearingOutcome(
    uuid: string,
    hearingId: number,
    input: HearingOutcomeInput,
  ): Promise<Record<string, unknown>> {
    const appeal = await this.findRow(uuid);

    if (input.outcome === 'ADJOURNED' && input.adjournedTo === undefined) {
      throw new BadRequestException(
        'An adjourned hearing must say what it was adjourned to, or the case has no next date.',
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE tax.tax_appeal_hearing
          SET outcome = :outcome, notes = :notes,
              adjourned_to = :adjournedTo::timestamptz, updated_at = CURRENT_TIMESTAMP
        WHERE id = :hearingId AND appeal_id = :appealId
      RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          hearingId,
          appealId: Number(appeal['id']),
          outcome: input.outcome,
          notes: input.notes ?? null,
          adjournedTo: input.adjournedTo ?? null,
        },
      },
    );

    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Hearing ${hearingId} was not found on appeal ${uuid}.`);
    }

    if (input.outcome === 'HELD') {
      await this.sequelize.query(
        `UPDATE tax.tax_appeal SET status = 'HEARD', updated_at = CURRENT_TIMESTAMP
          WHERE id = :id AND status IN ('FILED','LISTED')`,
        { type: QueryTypes.UPDATE, replacements: { id: Number(appeal['id']) } },
      );
    }

    return row;
  }

  /**
   * Record what the forum held.
   *
   * Transcription, not decision. The officer doing this is copying an external
   * judgment into the register, which is why the only validation is that a
   * reason is present and the outcome is one the machine understands.
   */
  async recordOutcome(
    uuid: string,
    input: AppealOutcomeInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const appeal = await this.findRow(uuid);

    if (appeal['status'] === 'DECIDED') {
      throw new ConflictException(
        `Appeal ${String(appeal['appeal_number'])} was already decided ` +
          `${String(appeal['outcome'])} on ${String(appeal['decided_on'])}.`,
      );
    }
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        "An appeal outcome must record the forum's reasons. They determine what the authority " +
          'now has to do, and a bare outcome does not.',
      );
    }

    const action = OUTCOME_ACTIONS[input.outcome];

    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `UPDATE tax.tax_appeal
            SET outcome = :outcome, outcome_reason = :reason,
                decided_on = COALESCE(:decidedOn::date, CURRENT_DATE),
                external_reference = COALESCE(:externalReference, external_reference),
                status = 'DECIDED',
                updated_at = CURRENT_TIMESTAMP, updated_by = :userId
          WHERE id = :id
        RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            id: Number(appeal['id']),
            outcome: input.outcome,
            reason: input.reason,
            decidedOn: input.decidedOn ?? null,
            externalReference: input.externalReference ?? null,
            userId: caller.userId ?? null,
          },
        },
      );

      await this.cases.transition(Number(appeal['case_id']), action, caller, {
        appealNumber: String(appeal['appeal_number']),
        outcome: input.outcome,
        forumCode: String(appeal['forum_code']),
      });

      this.logger.log(
        `Appeal ${String(appeal['appeal_number'])} decided ${input.outcome} by ` +
          String(appeal['forum_code']),
      );
      return rows[0]!;
    });
  }

  /**
   * Record that the decision has been given effect.
   *
   * Deliberately a separate act from recording the outcome. The gap between
   * the two is the thing a supervisor needs to see: an appeal won months ago
   * and never implemented means the taxpayer holds a judgment the register
   * does not reflect.
   */
  async implement(
    uuid: string,
    note: string,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const appeal = await this.findRow(uuid);

    if (appeal['outcome'] === null || appeal['outcome'] === undefined) {
      throw new ConflictException(
        `Appeal ${String(appeal['appeal_number'])} has no recorded outcome, so there is nothing ` +
          'to implement.',
      );
    }
    if (appeal['implemented_at'] !== null) {
      throw new ConflictException(
        `Appeal ${String(appeal['appeal_number'])} was already implemented on ` +
          `${String(appeal['implemented_at'])}.`,
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE tax.tax_appeal
          SET implemented_at = CURRENT_TIMESTAMP, implementation_note = :note,
              updated_at = CURRENT_TIMESTAMP, updated_by = :userId
        WHERE id = :id
      RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { id: Number(appeal['id']), note, userId: caller.userId ?? null },
      },
    );
    return rows[0]!;
  }

  async findByUuid(uuid: string): Promise<Record<string, unknown>> {
    const appeal = await this.findRow(uuid);
    const hearings = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, scheduled_for, venue, representative, outcome, notes, adjourned_to
         FROM tax.tax_appeal_hearing
        WHERE appeal_id = :id AND is_active
        ORDER BY scheduled_for`,
      { type: QueryTypes.SELECT, replacements: { id: Number(appeal['id']) } },
    );
    return { ...appeal, hearings };
  }

  async listForCase(caseId: number): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT uuid, appeal_number, forum_code, external_reference, filed_on::text AS filed_on,
              was_in_time, days_late, status, outcome, decided_on::text AS decided_on,
              implemented_at
         FROM tax.tax_appeal
        WHERE case_id = :caseId AND is_active
        ORDER BY id DESC`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
  }

  /**
   * The dispute register.
   *
   * Objections and appeals in one list, because the question a supervisor asks
   * is "what is in dispute", not "what objections exist".
   */
  async register(filters: {
    status?: string;
    overdueImplementationOnly?: boolean;
  }): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT 'OBJECTION' AS kind, o.uuid, o.objection_number AS reference, c.case_number,
              c.tin, o.filed_on::text AS filed_on, o.status, o.decision AS outcome,
              o.days_late, NULL::timestamptz AS implemented_at
         FROM tax.tax_objection o
         JOIN tax.tax_assessment_case c ON c.id = o.case_id
        WHERE o.is_active AND (:status::text IS NULL OR o.status = :status)
          AND NOT :overdueOnly
       UNION ALL
       SELECT 'APPEAL', a.uuid, a.appeal_number, c.case_number,
              c.tin, a.filed_on::text, a.status, a.outcome,
              a.days_late, a.implemented_at
         FROM tax.tax_appeal a
         JOIN tax.tax_assessment_case c ON c.id = a.case_id
        WHERE a.is_active AND (:status::text IS NULL OR a.status = :status)
          AND (NOT :overdueOnly OR (a.outcome IS NOT NULL AND a.implemented_at IS NULL))
        ORDER BY filed_on DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          status: filters.status ?? null,
          overdueOnly: filters.overdueImplementationOnly ?? false,
        },
      },
    );
  }

  // ------------------------------------------------------------------ internals

  private async findRow(uuid: string): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_appeal WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Appeal ${uuid} was not found.`);
    }
    return row;
  }

  /**
   * The forum must be one the jurisdiction recognises.
   *
   * Master data rather than an enum: the tribunals and courts that hear tax
   * appeals are different in every jurisdiction, and a hard-coded list is one
   * of the things that would make adding a second jurisdiction a code change.
   */
  private async assertForumExists(jurisdictionCode: string, forumCode: string): Promise<void> {
    const rows = await this.sequelize.query<{ item_code: string }>(
      `SELECT i.item_code
         FROM platform.master_data_item i
         JOIN platform.master_data d ON d.id = i.master_data_id
        WHERE d.group_code = 'APPEAL_FORUM'
          AND d.jurisdiction_code = :jurisdiction
          AND i.item_code = :forumCode
          AND d.is_active AND i.is_active`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode, forumCode } },
    );

    if (rows.length === 0) {
      const available = await this.sequelize.query<{ item_code: string }>(
        `SELECT i.item_code
           FROM platform.master_data_item i
           JOIN platform.master_data d ON d.id = i.master_data_id
          WHERE d.group_code = 'APPEAL_FORUM' AND d.jurisdiction_code = :jurisdiction
            AND d.is_active AND i.is_active
          ORDER BY i.sort_order, i.item_code`,
        { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode } },
      );
      throw new BadRequestException(
        `'${forumCode}' is not an appeal forum recognised in ${jurisdictionCode}. ` +
          `Configured forums are: ${available.map((r) => r.item_code).join(', ') || '(none)'}.`,
      );
    }
  }

  private async lateness(
    caseId: number,
    filedOn: string,
  ): Promise<{ deadlineOn: string | null; daysLate: number }> {
    const rows = await this.sequelize.query<{ due_at: string }>(
      `SELECT due_at::text AS due_at
         FROM tax.tax_assessment_deadline
        WHERE case_id = :caseId AND deadline_type = 'APPEAL' AND is_active
        ORDER BY id DESC
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const deadlineOn = rows[0]?.due_at?.slice(0, 10) ?? null;
    if (deadlineOn === null) return { deadlineOn: null, daysLate: 0 };
    return { deadlineOn, daysLate: daysBetween(deadlineOn, filedOn) };
  }

  private async latestObjection(caseId: number): Promise<Record<string, unknown> | undefined> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id FROM tax.tax_objection
        WHERE case_id = :caseId AND is_active
        ORDER BY id DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    return rows[0];
  }

  private async nextSequence(caseId: number, transaction: Transaction): Promise<number> {
    const rows = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tax.tax_appeal WHERE case_id = :caseId`,
      { type: QueryTypes.SELECT, transaction, replacements: { caseId } },
    );
    return Number(rows[0]?.count ?? 0) + 1;
  }
}

/**
 * Each forum outcome maps to exactly one transition in the case machine.
 *
 * Keyed by the outcome union rather than by `string`, so adding an outcome
 * without adding its transition is a compile error rather than an undefined
 * action discovered when a real appeal is recorded.
 */
const OUTCOME_ACTIONS: Readonly<Record<AppealOutcomeInput['outcome'], string>> = {
  UPHELD: 'RECORD_UPHELD',
  VARIED: 'RECORD_VARIED',
  SET_ASIDE: 'RECORD_SET_ASIDE',
  REMANDED: 'RECORD_REMANDED',
};
