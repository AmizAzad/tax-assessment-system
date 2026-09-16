import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';
import { DeadlineService } from '../deadline/deadline.service';
import { daysBetween, today } from '../deadline/business-calendar';

export interface FileObjectionInput {
  readonly groundsSummary: string;
  readonly grounds: readonly {
    groundCode: string;
    detail?: string;
    disputedAmount?: string;
    adjustmentId?: number;
  }[];
  readonly requestedRelief?: string;
  readonly filedChannel?: string;
  /** Back-dated filing, for an objection that arrived on paper. */
  readonly filedOn?: string;
}

export interface AdmissibilityInput {
  readonly admissibility: 'ADMITTED' | 'INADMISSIBLE';
  readonly reason: string;
}

export interface OpinionInput {
  readonly opinion: 'ALLOW' | 'PARTLY_ALLOW' | 'REJECT' | 'ABSTAIN';
  readonly reasoning?: string;
}

export interface DecisionInput {
  readonly decision: 'ALLOWED' | 'PARTLY_ALLOWED' | 'REJECTED';
  readonly reason: string;
  readonly groundOutcomes?: readonly { groundId: number; outcome: string; reason?: string }[];
}

/**
 * Handling a taxpayer's objection to an assessment.
 *
 * Plan reference: V2 sections 13.1 to 13.4 (Phase 6, stage 11).
 *
 * ## Lateness is computed; admissibility is decided
 *
 * These are deliberately separate. Whether an objection arrived after the
 * deadline is arithmetic, and the platform does it. Whether a late objection
 * should nonetheless be heard is a discretion the law gives to a person, and
 * the platform must not pre-empt it: a taxpayer in hospital, or one whose
 * notice went to an old address, has a claim that no date comparison can see.
 *
 * So a late objection is accepted, recorded as out of time with the number of
 * days, and put in front of an officer who must decide and say why.
 *
 * ## Who may decide
 *
 * Not the person who prepared or reviewed the assessment. An objection is a
 * challenge to their work, and letting them rule on it makes the right of
 * objection worthless. Enforced here as well as by role, because roles are
 * held by people who also work cases.
 */
@Injectable()
export class ObjectionService {
  private readonly logger = new Logger(ObjectionService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly deadlines: DeadlineService,
  ) {}

  /**
   * File an objection.
   *
   * Accepted even when out of time. Refusing here would deny a discretion the
   * law grants, and would leave no record that the taxpayer ever tried.
   */
  async file(
    caseId: number,
    input: FileObjectionInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const assessmentCase = await this.cases.findById(caseId);

    if (!canObjectFrom(assessmentCase.statusCode)) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. An objection lies ` +
          'against a served assessment; there is nothing here to object to yet.',
      );
    }

    if (input.grounds.length === 0) {
      throw new BadRequestException(
        'An objection must state at least one ground. An objection with no grounds cannot be ' +
          'decided, and in most jurisdictions is invalid on its face.',
      );
    }

    const filedOn = input.filedOn ?? today();
    const { deadlineOn, daysLate } = await this.lateness(caseId, filedOn);

    return this.sequelize.transaction(async (transaction) => {
      const sequence = await this.nextSequence(caseId, transaction);
      const objectionNumber = `${assessmentCase.caseNumber}-OBJ-${String(sequence).padStart(2, '0')}`;

      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_objection
                (case_id, objection_number, filed_on, filed_by_user_id, filed_channel,
                 grounds_summary, requested_relief, currency_code,
                 was_in_time, deadline_on, days_late, admissibility, status,
                 created_at, created_by, updated_at, updated_by, is_active)
         VALUES (:caseId, :objectionNumber, :filedOn::date, :userId, :channel,
                 :summary, :relief, :currency,
                 :inTime, :deadlineOn::date, :daysLate, 'PENDING', 'FILED',
                 CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId,
            objectionNumber,
            filedOn,
            userId: caller.userId ?? null,
            channel: input.filedChannel ?? 'PORTAL',
            summary: input.groundsSummary,
            relief:
              input.requestedRelief === undefined
                ? null
                : Money.of(input.requestedRelief, assessmentCase.currencyCode).toDatabaseValue(),
            currency: input.requestedRelief === undefined ? null : assessmentCase.currencyCode,
            inTime: daysLate === 0,
            deadlineOn,
            daysLate,
          },
        },
      );

      const objection = rows[0]!;

      for (const ground of input.grounds) {
        await this.sequelize.query(
          `INSERT INTO tax.tax_objection_ground
                  (objection_id, ground_code, detail, adjustment_id, disputed_amount,
                   created_at, created_by, updated_at, is_active)
           VALUES (:objectionId, :groundCode, :detail, :adjustmentId, :amount,
                   CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, true)`,
          {
            type: QueryTypes.INSERT,
            transaction,
            replacements: {
              objectionId: Number(objection['id']),
              groundCode: ground.groundCode,
              detail: ground.detail ?? null,
              adjustmentId: ground.adjustmentId ?? null,
              amount:
                ground.disputedAmount === undefined
                  ? null
                  : Money.of(ground.disputedAmount, assessmentCase.currencyCode).toDatabaseValue(),
              userId: caller.userId ?? null,
            },
          },
        );
      }

      // The objection window has done its job whether or not the objection was
      // in time: it is no longer waiting for anything.
      await this.deadlines.satisfy(caseId, 'OBJECTION');

      await this.cases.transition(caseId, 'FILE_OBJECTION', caller, {
        objectionNumber,
        daysLate,
        inTime: daysLate === 0,
      });

      this.logger.log(
        `Objection ${objectionNumber} filed on case ${assessmentCase.caseNumber}` +
          (daysLate > 0 ? ` (${daysLate} days out of time)` : ''),
      );

      return { ...objection, grounds: input.grounds.length };
    });
  }

  /**
   * Admit the objection, or refuse to hear it.
   *
   * An in-time objection still passes through here: some jurisdictions refuse
   * objections that are in time but defective, and recording the decision
   * explicitly means the file always says who admitted it.
   */
  async decideAdmissibility(
    uuid: string,
    input: AdmissibilityInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const objection = await this.findRow(uuid);
    await this.assertNotOwnWork(Number(objection['case_id']), caller);

    if (objection['admissibility'] !== 'PENDING') {
      throw new ConflictException(
        `Objection ${String(objection['objection_number'])} was already ruled ` +
          `${String(objection['admissibility'])}.`,
      );
    }

    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'An admissibility ruling must give a reason. Refusing to hear a person without one is ' +
          'not a decision they can challenge.',
      );
    }

    const inadmissible = input.admissibility === 'INADMISSIBLE';

    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `UPDATE tax.tax_objection
            SET admissibility = :admissibility,
                admissibility_reason = :reason,
                admitted_by = :userId,
                admitted_at = CURRENT_TIMESTAMP,
                status = CASE WHEN :inadmissible THEN 'REJECTED_INADMISSIBLE'
                              ELSE 'UNDER_CONSIDERATION' END,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = :userId
          WHERE id = :id
        RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            id: Number(objection['id']),
            admissibility: input.admissibility,
            reason: input.reason,
            inadmissible,
            userId: caller.userId ?? null,
          },
        },
      );

      if (inadmissible) {
        // Refusing to hear the objection leaves the assessment standing, so
        // the case follows the same path as a rejected objection.
        await this.cases.transition(Number(objection['case_id']), 'DECIDE_REJECTED', caller, {
          objectionNumber: String(objection['objection_number']),
          reason: `Inadmissible: ${input.reason}`,
        });
      }

      return rows[0]!;
    });
  }

  /** Record one panel member's opinion. Replaces their previous one. */
  async recordOpinion(
    uuid: string,
    input: OpinionInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const objection = await this.findRow(uuid);
    await this.assertNotOwnWork(Number(objection['case_id']), caller);

    if (caller.userId === undefined) {
      throw new ForbiddenException(
        'An opinion must be attributable to a person. The request carried no user identity.',
      );
    }

    if (objection['admissibility'] !== 'ADMITTED') {
      throw new ConflictException(
        `Objection ${String(objection['objection_number'])} has not been admitted, so there is ` +
          'nothing to give an opinion on yet.',
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO tax.tax_objection_opinion
              (objection_id, member_user_id, opinion, reasoning, given_at, created_at, is_active)
       VALUES (:objectionId, :userId, :opinion, :reasoning, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
       ON CONFLICT (objection_id, member_user_id) WHERE is_active
       DO UPDATE SET opinion = EXCLUDED.opinion,
                     reasoning = EXCLUDED.reasoning,
                     given_at = CURRENT_TIMESTAMP
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          objectionId: Number(objection['id']),
          userId: caller.userId,
          opinion: input.opinion,
          reasoning: input.reasoning ?? null,
        },
      },
    );
    return rows[0]!;
  }

  /**
   * Decide the objection.
   *
   * The decision is the officer's, not a tally of the opinions. Where a panel
   * has given opinions they are recorded and shown, and a decision that goes
   * against the majority is allowed but is logged, because that is precisely
   * the decision somebody will later be asked to justify.
   */
  async decide(
    uuid: string,
    input: DecisionInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const objection = await this.findRow(uuid);
    await this.assertNotOwnWork(Number(objection['case_id']), caller);

    if (objection['admissibility'] !== 'ADMITTED') {
      throw new ConflictException(
        `Objection ${String(objection['objection_number'])} has not been admitted. Rule on ` +
          'admissibility before deciding the merits.',
      );
    }
    if (objection['status'] === 'DECIDED') {
      throw new ConflictException(
        `Objection ${String(objection['objection_number'])} was already decided ` +
          `${String(objection['decision'])} on ${String(objection['decided_on'])}.`,
      );
    }
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'An objection decision must give reasons. A decision without them cannot be appealed ' +
          'against intelligibly, and in most jurisdictions is itself a ground of appeal.',
      );
    }

    await this.warnIfAgainstMajority(Number(objection['id']), input.decision);

    const action =
      input.decision === 'ALLOWED'
        ? 'DECIDE_ALLOWED'
        : input.decision === 'PARTLY_ALLOWED'
          ? 'DECIDE_PARTLY_ALLOWED'
          : 'DECIDE_REJECTED';

    return this.sequelize.transaction(async (transaction) => {
      for (const outcome of input.groundOutcomes ?? []) {
        await this.sequelize.query(
          `UPDATE tax.tax_objection_ground
              SET outcome = :outcome, outcome_reason = :reason, updated_at = CURRENT_TIMESTAMP
            WHERE id = :groundId AND objection_id = :objectionId`,
          {
            type: QueryTypes.UPDATE,
            transaction,
            replacements: {
              groundId: outcome.groundId,
              objectionId: Number(objection['id']),
              outcome: outcome.outcome,
              reason: outcome.reason ?? null,
            },
          },
        );
      }

      const rows = await this.sequelize.query<Record<string, unknown>>(
        `UPDATE tax.tax_objection
            SET decision = :decision, decision_reason = :reason,
                decided_by = :userId, decided_on = CURRENT_DATE,
                status = 'DECIDED', updated_at = CURRENT_TIMESTAMP, updated_by = :userId
          WHERE id = :id
        RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            id: Number(objection['id']),
            decision: input.decision,
            reason: input.reason,
            userId: caller.userId ?? null,
          },
        },
      );

      await this.cases.transition(Number(objection['case_id']), action, caller, {
        objectionNumber: String(objection['objection_number']),
        decision: input.decision,
      });

      // An allowed or partly allowed objection opens the appeal window for the
      // taxpayer against what is left, and a rejection certainly does.
      await this.deadlines.materialise(
        await this.cases.findById(Number(objection['case_id'])),
        'OBJECTION_DECIDED',
        today(),
        caller,
      );

      this.logger.log(
        `Objection ${String(objection['objection_number'])} decided ${input.decision}`,
      );
      return rows[0]!;
    });
  }

  async withdraw(
    uuid: string,
    reason: string,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const objection = await this.findRow(uuid);

    if (objection['status'] === 'DECIDED') {
      throw new ConflictException(
        'A decided objection cannot be withdrawn. Appeal the decision instead.',
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE tax.tax_objection
          SET status = 'WITHDRAWN',
              decision_reason = :reason,
              updated_at = CURRENT_TIMESTAMP, updated_by = :userId
        WHERE id = :id
      RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { id: Number(objection['id']), reason, userId: caller.userId ?? null },
      },
    );

    // Withdrawing leaves the assessment standing, which is the same position
    // as a rejection.
    await this.cases.transition(Number(objection['case_id']), 'DECIDE_REJECTED', caller, {
      objectionNumber: String(objection['objection_number']),
      reason: `Withdrawn by the taxpayer: ${reason}`,
    });

    return rows[0]!;
  }

  async findByUuid(uuid: string): Promise<Record<string, unknown>> {
    const objection = await this.findRow(uuid);
    const [grounds, opinions] = await Promise.all([
      this.sequelize.query<Record<string, unknown>>(
        `SELECT id, ground_code, detail, disputed_amount::text AS disputed_amount,
                outcome, outcome_reason
           FROM tax.tax_objection_ground
          WHERE objection_id = :id AND is_active
          ORDER BY id`,
        { type: QueryTypes.SELECT, replacements: { id: Number(objection['id']) } },
      ),
      this.sequelize.query<Record<string, unknown>>(
        `SELECT o.member_user_id, u.username, o.opinion, o.reasoning, o.given_at
           FROM tax.tax_objection_opinion o
           LEFT JOIN platform.app_user u ON u.id = o.member_user_id
          WHERE o.objection_id = :id AND o.is_active
          ORDER BY o.given_at`,
        { type: QueryTypes.SELECT, replacements: { id: Number(objection['id']) } },
      ),
    ]);
    return { ...objection, grounds, opinions };
  }

  async listForCase(caseId: number): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT uuid, objection_number, filed_on::text AS filed_on, was_in_time, days_late,
              admissibility, status, decision, decided_on::text AS decided_on
         FROM tax.tax_objection
        WHERE case_id = :caseId AND is_active
        ORDER BY id DESC`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
  }

  // ------------------------------------------------------------------ internals

  private async findRow(uuid: string): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_objection WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Objection ${uuid} was not found.`);
    }
    return row;
  }

  /**
   * How late the objection was, against the recorded objection deadline.
   *
   * Uses the materialised deadline rather than recomputing, because the
   * recorded one has already been anchored on the deemed service date and
   * re-anchored if that moved. Recomputing here could quietly disagree with
   * the date the taxpayer was shown.
   */
  private async lateness(
    caseId: number,
    filedOn: string,
  ): Promise<{ deadlineOn: string | null; daysLate: number }> {
    const rows = await this.sequelize.query<{ due_at: string }>(
      `SELECT due_at::text AS due_at
         FROM tax.tax_assessment_deadline
        WHERE case_id = :caseId AND deadline_type = 'OBJECTION' AND is_active
        ORDER BY id DESC
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const deadlineOn = rows[0]?.due_at?.slice(0, 10) ?? null;
    // No recorded deadline means nothing has established a window, and an
    // objection cannot be late against a date that does not exist.
    if (deadlineOn === null) return { deadlineOn: null, daysLate: 0 };

    return { deadlineOn, daysLate: daysBetween(deadlineOn, filedOn) };
  }

  /**
   * Nobody may rule on a challenge to their own work.
   *
   * Checked against recorded participation on the case, the same source
   * segregation of duties uses, so an officer who prepared or reviewed the
   * assessment cannot decide the objection against it.
   */
  private async assertNotOwnWork(caseId: number, caller: RequestContext): Promise<void> {
    if (caller.userId === undefined) {
      throw new ForbiddenException(
        'Deciding an objection requires an identified caller, so that the platform can confirm ' +
          'the decision is not being taken by the officer whose work is challenged.',
      );
    }

    const rows = await this.sequelize.query<{ role_code: string }>(
      `SELECT DISTINCT role_code
         FROM tax.tax_assessment_assignment
        WHERE case_id = :caseId AND user_id = :userId
          AND role_code IN (:barred)`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          caseId,
          userId: caller.userId,
          barred: [RoleCode.ASSESSOR, RoleCode.REVIEWER],
        },
      },
    );

    if (rows.length > 0) {
      throw new ForbiddenException(
        `You acted on this case as ${rows.map((r) => r.role_code).join(', ')}. An objection is a ` +
          'challenge to that work, so it must be decided by someone else.',
      );
    }
  }

  /** Log a decision that departs from the panel, because it will be questioned. */
  private async warnIfAgainstMajority(objectionId: number, decision: string): Promise<void> {
    const rows = await this.sequelize.query<{ opinion: string; count: string }>(
      `SELECT opinion, count(*)::text AS count
         FROM tax.tax_objection_opinion
        WHERE objection_id = :objectionId AND is_active AND opinion <> 'ABSTAIN'
        GROUP BY opinion
        ORDER BY count(*) DESC`,
      { type: QueryTypes.SELECT, replacements: { objectionId } },
    );

    if (rows.length === 0) return;

    const leading = rows[0]!;
    const expected =
      leading.opinion === 'ALLOW'
        ? 'ALLOWED'
        : leading.opinion === 'PARTLY_ALLOW'
          ? 'PARTLY_ALLOWED'
          : 'REJECTED';

    if (expected !== decision) {
      this.logger.warn(
        `Objection ${objectionId} decided ${decision} against a panel majority of ` +
          `${leading.opinion} (${leading.count}). Permitted, but the reasons should address it.`,
      );
    }
  }

  private async nextSequence(caseId: number, transaction: Transaction): Promise<number> {
    const rows = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tax.tax_objection WHERE case_id = :caseId`,
      { type: QueryTypes.SELECT, transaction, replacements: { caseId } },
    );
    return Number(rows[0]?.count ?? 0) + 1;
  }
}

/**
 * An objection lies against a served assessment.
 *
 * `CLOSED` is included because a taxpayer may object after the window lapsed
 * and the case closed; whether that late objection is heard is the
 * admissibility decision, not something to refuse at the door.
 */
function canObjectFrom(status: string): boolean {
  const permitted: readonly string[] = [
    CaseStatus.NOTICE_SERVED,
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
  ];
  return permitted.includes(status);
}
