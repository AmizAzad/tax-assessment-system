import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { DepositService } from '../dispute/deposit.service';
import { ObjectionService, type FileObjectionInput } from '../dispute/objection.service';

export interface PortalIdentity {
  readonly taxpayerId: number;
  readonly tin: string;
  readonly name: string;
  readonly relationship: string;
  readonly jurisdictionCode: string;
}

/**
 * What a taxpayer may see and do about their own affairs.
 *
 * Plan reference: V2 sections 15.1 to 15.4.
 *
 * ## The single rule this service exists to enforce
 *
 * **A taxpayer never supplies the identifier that decides whose data they
 * see.** Every method resolves the caller's taxpayer from
 * `platform.taxpayer_user` and filters on that, in SQL. Where a method takes a
 * case id, the id narrows a set already restricted to the caller's own cases;
 * it does not select which taxpayer's cases are in that set.
 *
 * The difference matters because identifiers are guessable. A portal that
 * trusted `?taxpayerId=` would disclose one company's assessment to another on
 * the first curious afternoon, and the access log would show a perfectly
 * ordinary request.
 *
 * ## Why a missing authority is a 403 and not an empty list
 *
 * Somebody holding the taxpayer role with no authority on file is a
 * misconfiguration, and returning an empty register would present it as "you
 * have no assessments" — which the person would believe. Saying plainly that
 * no authority is recorded sends them to whoever can fix it.
 *
 * ## What is deliberately absent
 *
 * No calculation trace, no adjustments, no evidence, no internal notes. A
 * taxpayer is entitled to the notice served on them and to the figures it
 * states; the officer's working papers are a different question, decided by
 * the jurisdiction's disclosure rules rather than by what is convenient to
 * expose.
 */

/**
 * The statuses a taxpayer may see.
 *
 * Defined once and applied by every method. The first version of this service
 * filtered the list but not the detail, so a taxpayer who guessed one of their
 * own case ids could read an assessment still in preparation: figures nobody
 * had decided, presented as though they had been. Two methods disagreeing
 * about what may be disclosed is exactly the kind of gap a boundary probe
 * exists to find.
 *
 * An assessment becomes the taxpayer's business when it is served on them, and
 * not before.
 */
const VISIBLE_TO_TAXPAYER: readonly string[] = [
  'NOTICE_SERVED',
  'AWAITING_TAXPAYER_RESPONSE',
  'UNDER_OBJECTION',
  'OBJECTION_ALLOWED',
  'OBJECTION_PARTLY_ALLOWED',
  'OBJECTION_REJECTED',
  'UNDER_APPEAL',
  'APPEAL_UPHELD',
  'APPEAL_VARIED',
  'APPEAL_SET_ASIDE',
  'APPEAL_REMANDED',
  'SETTLED',
  'CLOSED',
];

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly objections: ObjectionService,
    private readonly deposits: DepositService,
  ) {}

  /**
   * Who this caller acts for.
   *
   * Resolved once per request by the methods below rather than trusted from a
   * token claim: authority ends, and a token issued this morning should not
   * still open a taxpayer's file this afternoon.
   */
  async identity(caller: RequestContext): Promise<PortalIdentity> {
    if (caller.userId === undefined) {
      throw new ForbiddenException(
        'The portal requires an identified caller. This request carried no user identity.',
      );
    }

    const rows = await this.sequelize.query<{
      taxpayer_id: string;
      tin: string;
      name: string;
      relationship: string;
      jurisdiction_code: string;
    }>(
      `SELECT tu.taxpayer_id::text AS taxpayer_id, t.tin, t.name,
              tu.relationship, t.jurisdiction_code
         FROM platform.taxpayer_user tu
         JOIN platform.taxpayer t ON t.id = tu.taxpayer_id
        WHERE tu.user_id = :userId
          AND tu.is_active
          AND tu.valid_from <= CURRENT_DATE
          AND (tu.valid_to IS NULL OR tu.valid_to > CURRENT_DATE)
        ORDER BY tu.id
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { userId: caller.userId } },
    );

    const row = rows[0];
    if (row === undefined) {
      this.logger.warn(
        `User ${caller.username ?? caller.userId} reached the portal with no authority on file.`,
      );
      throw new ForbiddenException(
        'No taxpayer authority is recorded for this account. If you act for a taxpayer, ask ' +
          'them or the authority to register your authority before using the portal.',
      );
    }

    return {
      taxpayerId: Number(row.taxpayer_id),
      tin: row.tin,
      name: row.name,
      relationship: row.relationship,
      jurisdictionCode: row.jurisdiction_code,
    };
  }

  /** The taxpayer's own assessments. */
  async cases(caller: RequestContext): Promise<readonly Record<string, unknown>[]> {
    const me = await this.identity(caller);
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.id, c.case_number, c.tax_type_code, c.assessment_year, c.status_code,
              c.currency_code, c.net_payable::text AS net_payable, c.opened_at
         FROM tax.tax_assessment_case c
        WHERE c.taxpayer_id = :taxpayerId
          AND c.is_active
          AND c.status_code IN (:visible)
        ORDER BY c.opened_at DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { taxpayerId: me.taxpayerId, visible: [...VISIBLE_TO_TAXPAYER] },
      },
    );
  }

  /**
   * One assessment, with the figures the notice states.
   *
   * The case id narrows a set already restricted to this caller's taxpayer.
   * A case belonging to somebody else simply is not found.
   */
  async caseDetail(caller: RequestContext, caseId: number): Promise<Record<string, unknown>> {
    const me = await this.identity(caller);

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT c.id, c.case_number, c.tax_type_code, c.assessment_year, c.status_code,
              c.currency_code, c.opened_at,
              r.taxable_base::text AS taxable_base,
              r.tax_before_credits::text AS tax_before_credits,
              r.total_credits::text AS total_credits,
              r.penalty_amount::text AS penalty_amount,
              r.interest_amount::text AS interest_amount,
              r.net_payable_or_refundable::text AS net_payable_or_refundable
         FROM tax.tax_assessment_case c
         LEFT JOIN tax.tax_calculation_result r ON r.case_id = c.id AND r.is_current
        WHERE c.id = :caseId
          AND c.taxpayer_id = :taxpayerId
          AND c.is_active
          AND c.status_code IN (:visible)`,
      {
        type: QueryTypes.SELECT,
        replacements: { caseId, taxpayerId: me.taxpayerId, visible: [...VISIBLE_TO_TAXPAYER] },
      },
    );

    const row = rows[0];
    if (row === undefined) {
      // Deliberately the same answer as a case that does not exist. Telling a
      // caller that a case exists but is not theirs confirms the existence of
      // another taxpayer's assessment.
      throw new NotFoundException('No such assessment.');
    }
    return row;
  }

  /** Notices served on the taxpayer. */
  async notices(
    caller: RequestContext,
    caseId: number,
  ): Promise<readonly Record<string, unknown>[]> {
    const me = await this.identity(caller);
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT n.uuid, n.notice_number, n.notice_type, n.version, n.language_code,
              n.issued_at, n.deemed_served_on, n.rendered_title, n.rendered_body,
              d.uuid AS document_uuid
         FROM tax.tax_assessment_notice n
         JOIN tax.tax_assessment_case c ON c.id = n.case_id
         LEFT JOIN platform.document d ON d.id = n.document_id
        WHERE c.id = :caseId
          AND c.taxpayer_id = :taxpayerId
          AND n.is_active
          -- Only served notices. A draft or an unserved one has no legal
          -- effect on the taxpayer and showing it would start an argument
          -- about a document they were never given.
          AND n.status = 'SERVED'
          AND c.status_code IN (:visible)
        ORDER BY n.notice_type, n.version DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { caseId, taxpayerId: me.taxpayerId, visible: [...VISIBLE_TO_TAXPAYER] },
      },
    );
  }

  /**
   * Confirm a notice belongs to this caller before it is downloaded.
   *
   * Returns the document uuid rather than the bytes: the document service
   * already handles streaming and access logging, and duplicating that here
   * would give two code paths to a taxpayer's file.
   */
  async noticeDocument(caller: RequestContext, noticeUuid: string): Promise<string> {
    const me = await this.identity(caller);
    const rows = await this.sequelize.query<{ document_uuid: string | null }>(
      `SELECT d.uuid AS document_uuid
         FROM tax.tax_assessment_notice n
         JOIN tax.tax_assessment_case c ON c.id = n.case_id
         LEFT JOIN platform.document d ON d.id = n.document_id
        WHERE n.uuid = :noticeUuid
          AND c.taxpayer_id = :taxpayerId
          AND n.is_active
          AND n.status = 'SERVED'`,
      { type: QueryTypes.SELECT, replacements: { noticeUuid, taxpayerId: me.taxpayerId } },
    );

    const documentUuid = rows[0]?.document_uuid;
    if (documentUuid === null || documentUuid === undefined) {
      throw new NotFoundException('No such notice.');
    }
    return documentUuid;
  }

  async objectionsFor(
    caller: RequestContext,
    caseId: number,
  ): Promise<readonly Record<string, unknown>[]> {
    const me = await this.identity(caller);
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT o.uuid, o.objection_number, o.filed_on::text AS filed_on,
              o.was_in_time, o.days_late, o.admissibility, o.status,
              o.decision, o.decided_on::text AS decided_on, o.decision_reason,
              o.deposit_required::text AS deposit_required,
              o.deposit_paid::text AS deposit_paid
         FROM tax.tax_objection o
         JOIN tax.tax_assessment_case c ON c.id = o.case_id
        WHERE c.id = :caseId
          AND c.taxpayer_id = :taxpayerId
          AND o.is_active
          AND c.status_code IN (:visible)
        ORDER BY o.id DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { caseId, taxpayerId: me.taxpayerId, visible: [...VISIBLE_TO_TAXPAYER] },
      },
    );
  }

  /**
   * File an objection against one's own assessment.
   *
   * Ownership is checked here, and the objection service then applies every
   * rule it applies to an officer-recorded objection: the grounds requirement,
   * the lateness calculation, the case-status check. A taxpayer filing through
   * the portal is not held to a different standard than one who posts a letter,
   * in either direction.
   */
  async fileObjection(
    caller: RequestContext,
    caseId: number,
    input: FileObjectionInput,
  ): Promise<Record<string, unknown>> {
    const me = await this.identity(caller);
    await this.assertOwnCase(me.taxpayerId, caseId);

    this.logger.log(
      `Objection filed through the portal on case ${caseId} by ${caller.username ?? caller.userId} ` +
        `acting as ${me.relationship} for ${me.tin}`,
    );

    return this.objections.file(caseId, { ...input, filedChannel: 'PORTAL' }, caller);
  }

  async depositFor(caller: RequestContext, objectionUuid: string) {
    const me = await this.identity(caller);

    const rows = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tax.tax_objection o
         JOIN tax.tax_assessment_case c ON c.id = o.case_id
        WHERE o.uuid = :objectionUuid AND c.taxpayer_id = :taxpayerId AND o.is_active`,
      { type: QueryTypes.SELECT, replacements: { objectionUuid, taxpayerId: me.taxpayerId } },
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      throw new NotFoundException('No such objection.');
    }

    return this.deposits.assess(objectionUuid);
  }

  /** Payments, credits and losses the authority holds for this taxpayer. */
  async account(caller: RequestContext): Promise<Record<string, unknown>> {
    const me = await this.identity(caller);

    const entries = await this.sequelize.query<Record<string, unknown>>(
      `SELECT tax_type_code, assessment_year, entry_type, credit_code,
              amount::text AS amount, currency_code, value_date::text AS value_date,
              narrative
         FROM tax.taxpayer_account_entry
        WHERE taxpayer_id = :taxpayerId AND is_active
        ORDER BY value_date DESC, id DESC`,
      { type: QueryTypes.SELECT, replacements: { taxpayerId: me.taxpayerId } },
    );

    const losses = await this.sequelize.query<Record<string, unknown>>(
      `SELECT tax_type_code, origin_year, loss_type,
              original_amount::text AS original_amount,
              consumed_amount::text AS consumed_amount,
              (original_amount - consumed_amount)::text AS remaining_amount,
              currency_code
         FROM tax.taxpayer_loss
        WHERE taxpayer_id = :taxpayerId AND is_active
        ORDER BY origin_year`,
      { type: QueryTypes.SELECT, replacements: { taxpayerId: me.taxpayerId } },
    );

    return { taxpayer: me, entries, losses };
  }

  // ------------------------------------------------------------------ internals

  private async assertOwnCase(taxpayerId: number, caseId: number): Promise<void> {
    const rows = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tax.tax_assessment_case
        WHERE id = :caseId AND taxpayer_id = :taxpayerId AND is_active
          AND status_code IN (:visible)`,
      {
        type: QueryTypes.SELECT,
        replacements: { caseId, taxpayerId, visible: [...VISIBLE_TO_TAXPAYER] },
      },
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      throw new NotFoundException('No such assessment.');
    }
  }
}
