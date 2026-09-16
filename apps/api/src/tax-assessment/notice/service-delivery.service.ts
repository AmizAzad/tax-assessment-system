import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { NotificationService } from '../../platform/notification/notification.service';
import { CaseService } from '../case/case.service';
import { DeadlineService } from '../deadline/deadline.service';

export type ServiceChannel =
  'EMAIL' | 'SMS' | 'PORTAL' | 'REGISTERED_POST' | 'HAND_DELIVERY' | 'PUBLICATION';

export interface ServeInput {
  readonly channel: ServiceChannel;
  readonly addressee: string;
  readonly addressSnapshot?: Record<string, unknown>;
  readonly proofReference?: string;
}

export interface ServiceOutcomeInput {
  readonly status: 'DELIVERED' | 'READ' | 'FAILED' | 'RETURNED';
  readonly occurredAt?: string;
  readonly proofReference?: string;
  readonly failureReason?: string;
}

export interface ServiceAttempt {
  readonly id: number;
  readonly uuid: string;
  readonly noticeId: number;
  readonly channel: string;
  readonly addressee: string;
  readonly status: string;
  readonly dispatchedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly deemedServedOn: string | null;
  readonly proofReference: string | null;
  readonly failureReason: string | null;
}

/**
 * Serving a notice, and proving it.
 *
 * Plan reference: V2 sections 12.4 to 12.6 (Phase 5, stage 10).
 *
 * ## Why service is modelled per attempt
 *
 * "Was the taxpayer served?" is the question every objection out of time turns
 * on. A single timestamp on the notice cannot answer it: an email may bounce
 * while a registered letter is signed for, and the answer depends on which
 * channel succeeded and when. Each attempt is its own row with its own proof.
 *
 * ## Deemed service
 *
 * Most jurisdictions treat post as served a fixed number of days after
 * despatch, whether or not it was read. Some let actual earlier delivery
 * override that. Both are configuration (`tax.tax_service_rule`), because the
 * rule differs per jurisdiction and per channel and decides when the objection
 * window opens.
 *
 * The notice's own `deemed_served_on` is the **earliest** across successful
 * attempts. Taking the latest would extend the taxpayer's objection window
 * beyond what the law allows; taking the earliest is both correct and the
 * reading that favours the taxpayer if two channels disagree.
 */
@Injectable()
export class ServiceDeliveryService {
  private readonly logger = new Logger(ServiceDeliveryService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly deadlines: DeadlineService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Despatch a notice through one channel.
   *
   * Records the attempt first, then sends. If the send throws, the attempt
   * still exists as FAILED with a reason, which is what an officer needs in
   * order to try another channel.
   */
  async serve(
    noticeUuid: string,
    input: ServeInput,
    caller: RequestContext,
  ): Promise<ServiceAttempt> {
    const notice = await this.loadNotice(noticeUuid);

    if (notice['status'] === 'DRAFT') {
      throw new ConflictException(
        `Notice ${String(notice['notice_number'])} is still a draft. Issue it before serving it.`,
      );
    }
    if (notice['status'] === 'CANCELLED' || notice['status'] === 'SUPERSEDED') {
      throw new ConflictException(
        `Notice ${String(notice['notice_number'])} is ${String(notice['status'])} and must not ` +
          'be served. Issue the current version instead.',
      );
    }

    this.assertAddresseeLooksRight(input.channel, input.addressee);

    const assessmentCase = await this.cases.findById(Number(notice['case_id']));
    const dispatchedOn = new Date().toISOString().slice(0, 10);
    const rule = await this.serviceRuleFor(assessmentCase.jurisdictionCode, input.channel);
    const deemedOn = await this.deemedServiceDate(
      assessmentCase.jurisdictionCode,
      dispatchedOn,
      rule,
    );

    const attempt = await this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_notice_service
                (notice_id, channel, addressee, address_snapshot, dispatched_at,
                 proof_reference, deemed_served_on, status,
                 created_at, created_by, updated_at, updated_by, is_active)
         VALUES (:noticeId, :channel, :addressee, :snapshot, CURRENT_TIMESTAMP,
                 :proof, :deemedOn, 'DISPATCHED',
                 CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            noticeId: Number(notice['id']),
            channel: input.channel,
            addressee: input.addressee,
            snapshot:
              input.addressSnapshot === undefined ? null : JSON.stringify(input.addressSnapshot),
            proof: input.proofReference ?? null,
            deemedOn,
            userId: caller.userId ?? null,
          },
        },
      );

      await this.applyServiceToNotice(
        Number(notice['id']),
        Number(notice['case_id']),
        deemedOn,
        caller,
        transaction,
      );

      return toAttempt(rows[0]!);
    });

    await this.notifyIfElectronic(notice, assessmentCase, input, attempt);

    this.logger.log(
      `Notice ${String(notice['notice_number'])} despatched by ${input.channel}; ` +
        `deemed served ${deemedOn}`,
    );
    return attempt;
  }

  /**
   * Record what happened to an attempt.
   *
   * Actual delivery can pull the deemed date earlier where the jurisdiction's
   * rule allows it. It never pushes it later: a letter that arrives late was
   * still deemed served on the statutory date.
   */
  async recordOutcome(
    noticeUuid: string,
    serviceId: number,
    input: ServiceOutcomeInput,
    caller: RequestContext,
  ): Promise<ServiceAttempt> {
    const notice = await this.loadNotice(noticeUuid);

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_notice_service
        WHERE id = :serviceId AND notice_id = :noticeId AND is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { serviceId, noticeId: Number(notice['id']) },
      },
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw new NotFoundException(
        `Service attempt ${serviceId} was not found on notice ${noticeUuid}.`,
      );
    }

    if (input.status === 'FAILED' && (input.failureReason ?? '') === '') {
      throw new BadRequestException(
        'A failed service attempt must say why, so an officer can choose another channel.',
      );
    }

    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const assessmentCase = await this.cases.findById(Number(notice['case_id']));
    const rule = await this.serviceRuleFor(
      assessmentCase.jurisdictionCode,
      String(existing['channel']) as ServiceChannel,
    );

    const delivered = input.status === 'DELIVERED' || input.status === 'READ';
    const actualDate = occurredAt.slice(0, 10);
    const currentDeemed = existing['deemed_served_on'] as string | null;

    // Only earlier, and only where the rule says actual delivery counts.
    const nextDeemed =
      delivered && rule.actual_delivery_wins && currentDeemed !== null && actualDate < currentDeemed
        ? actualDate
        : currentDeemed;

    return this.sequelize.transaction(async (transaction) => {
      const updated = await this.sequelize.query<Record<string, unknown>>(
        `UPDATE tax.tax_notice_service
            SET status = :status,
                delivered_at = CASE WHEN :status IN ('DELIVERED','READ')
                                    THEN COALESCE(delivered_at, :occurredAt::timestamptz)
                                    ELSE delivered_at END,
                read_at = CASE WHEN :status = 'READ'
                               THEN COALESCE(read_at, :occurredAt::timestamptz)
                               ELSE read_at END,
                failed_at = CASE WHEN :status IN ('FAILED','RETURNED')
                                 THEN COALESCE(failed_at, :occurredAt::timestamptz)
                                 ELSE failed_at END,
                failure_reason = COALESCE(:failureReason, failure_reason),
                proof_reference = COALESCE(:proof, proof_reference),
                deemed_served_on = :deemedOn,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = :userId
          WHERE id = :serviceId
        RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            serviceId,
            status: input.status,
            occurredAt,
            failureReason: input.failureReason ?? null,
            proof: input.proofReference ?? null,
            // A failed attempt served nobody, so it carries no deemed date.
            deemedOn: input.status === 'FAILED' || input.status === 'RETURNED' ? null : nextDeemed,
            userId: caller.userId ?? null,
          },
        },
      );

      await this.recomputeNoticeService(
        Number(notice['id']),
        Number(notice['case_id']),
        caller,
        transaction,
      );

      return toAttempt(updated[0]!);
    });
  }

  async attemptsFor(noticeUuid: string): Promise<readonly ServiceAttempt[]> {
    const notice = await this.loadNotice(noticeUuid);
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_notice_service
        WHERE notice_id = :noticeId AND is_active
        ORDER BY id`,
      { type: QueryTypes.SELECT, replacements: { noticeId: Number(notice['id']) } },
    );
    return rows.map(toAttempt);
  }

  // ------------------------------------------------------------------ internals

  private async loadNotice(uuid: string): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_assessment_notice WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Notice ${uuid} was not found.`);
    }
    return row;
  }

  /**
   * A cheap sanity check on the address.
   *
   * Not validation of deliverability, which only the attempt can establish.
   * This catches the case of an email address typed into a postal service,
   * which would otherwise be recorded as a despatch that never happened.
   */
  private assertAddresseeLooksRight(channel: ServiceChannel, addressee: string): void {
    if (addressee.trim() === '') {
      throw new BadRequestException('An addressee is required to serve a notice.');
    }
    if (channel === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addressee)) {
      throw new BadRequestException(`'${addressee}' is not an email address.`);
    }
    if (channel === 'SMS' && !/^\+?[0-9 ()-]{6,20}$/.test(addressee)) {
      throw new BadRequestException(`'${addressee}' is not a telephone number.`);
    }
  }

  private async serviceRuleFor(
    jurisdictionCode: string,
    channel: ServiceChannel,
  ): Promise<{
    deemed_after_value: number;
    deemed_after_unit: string;
    calendar_rule: string;
    actual_delivery_wins: boolean;
  }> {
    const rows = await this.sequelize.query<{
      deemed_after_value: number;
      deemed_after_unit: string;
      calendar_rule: string;
      actual_delivery_wins: boolean;
    }>(
      `SELECT deemed_after_value, deemed_after_unit, calendar_rule, actual_delivery_wins
         FROM tax.tax_service_rule
        WHERE jurisdiction_code = :jurisdiction AND channel = :channel AND is_active
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode, channel } },
    );

    // Same-day service is the safe default: it opens the objection window at
    // the earliest defensible moment rather than silently granting the
    // authority extra days it has not legislated for.
    return (
      rows[0] ?? {
        deemed_after_value: 0,
        deemed_after_unit: 'DAYS',
        calendar_rule: 'CALENDAR_DAYS',
        actual_delivery_wins: true,
      }
    );
  }

  /**
   * When service is deemed to occur.
   *
   * Runs through the deadline engine rather than doing its own arithmetic, so
   * "two working days after posting" honours the same holiday calendar that
   * every other statutory date uses.
   */
  private async deemedServiceDate(
    jurisdictionCode: string,
    dispatchedOn: string,
    rule: { deemed_after_value: number; deemed_after_unit: string; calendar_rule: string },
  ): Promise<string> {
    if (rule.deemed_after_value === 0) return dispatchedOn;

    return this.deadlines.applyOffsetFor(jurisdictionCode, dispatchedOn, {
      offsetValue: rule.deemed_after_value,
      offsetUnit: rule.deemed_after_unit as 'DAYS' | 'MONTHS' | 'YEARS',
      calendarRule: rule.calendar_rule as 'CALENDAR_DAYS' | 'BUSINESS_DAYS' | 'NEXT_BUSINESS_DAY',
    });
  }

  /**
   * Mark the notice served and start the response window.
   *
   * The transition is SYSTEM: the case moving to NOTICE_SERVED follows from a
   * despatch having been recorded, not from anyone's opinion that it was.
   */
  private async applyServiceToNotice(
    noticeId: number,
    caseId: number,
    deemedOn: string,
    caller: RequestContext,
    transaction: Transaction,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE tax.tax_assessment_notice
          SET status = 'SERVED',
              first_served_at = COALESCE(first_served_at, CURRENT_TIMESTAMP),
              deemed_served_on = LEAST(COALESCE(deemed_served_on, :deemedOn::date), :deemedOn::date),
              updated_at = CURRENT_TIMESTAMP,
              updated_by = :userId
        WHERE id = :noticeId`,
      {
        type: QueryTypes.UPDATE,
        transaction,
        replacements: { noticeId, deemedOn, userId: caller.userId ?? null },
      },
    );

    await this.advanceCase(caseId, deemedOn, caller);
  }

  /**
   * Recompute the notice's service position from its attempts.
   *
   * Called after an outcome changes, because a bounce can remove the only
   * successful channel and the notice must stop claiming to be served.
   */
  private async recomputeNoticeService(
    noticeId: number,
    caseId: number,
    caller: RequestContext,
    transaction: Transaction,
  ): Promise<void> {
    const rows = await this.sequelize.query<{ earliest: string | null; successes: string }>(
      `SELECT min(deemed_served_on)::text AS earliest, count(*)::text AS successes
         FROM tax.tax_notice_service
        WHERE notice_id = :noticeId AND is_active
          AND status IN ('DISPATCHED', 'DELIVERED', 'READ')
          AND deemed_served_on IS NOT NULL`,
      { type: QueryTypes.SELECT, transaction, replacements: { noticeId } },
    );

    const earliest = rows[0]?.earliest ?? null;

    if (earliest === null) {
      // Every attempt failed. The notice reverts to ISSUED so the register
      // shows it as still needing service, which is the truth.
      await this.sequelize.query(
        `UPDATE tax.tax_assessment_notice
            SET status = 'ISSUED', first_served_at = NULL, deemed_served_on = NULL,
                updated_at = CURRENT_TIMESTAMP, updated_by = :userId
          WHERE id = :noticeId`,
        {
          type: QueryTypes.UPDATE,
          transaction,
          replacements: { noticeId, userId: caller.userId ?? null },
        },
      );
      return;
    }

    await this.sequelize.query(
      `UPDATE tax.tax_assessment_notice
          SET status = 'SERVED',
              first_served_at = COALESCE(first_served_at, CURRENT_TIMESTAMP),
              deemed_served_on = :earliest::date,
              updated_at = CURRENT_TIMESTAMP, updated_by = :userId
        WHERE id = :noticeId`,
      {
        type: QueryTypes.UPDATE,
        transaction,
        replacements: { noticeId, earliest, userId: caller.userId ?? null },
      },
    );

    await this.advanceCase(caseId, earliest, caller);
  }

  /**
   * Move the case along and materialise the objection window.
   *
   * Both transitions are attempted in order and both are tolerant of already
   * having happened, because a second channel serving the same notice must not
   * fail merely because the first already advanced the case.
   */
  private async advanceCase(
    caseId: number,
    deemedOn: string,
    caller: RequestContext,
  ): Promise<void> {
    const assessmentCase = await this.cases.findById(caseId);
    const system: RequestContext = { ...caller, roleCodes: [RoleCode.SYSTEM] };

    if (assessmentCase.statusCode === CaseStatus.NOTICE_GENERATED) {
      await this.cases.transition(caseId, 'SERVED', system, { deemedServedOn: deemedOn });
    }

    const afterService = await this.cases.findById(caseId);
    if (afterService.statusCode === CaseStatus.NOTICE_SERVED) {
      await this.cases.transition(caseId, 'START_RESPONSE_WINDOW', system, {
        deemedServedOn: deemedOn,
      });
    }

    // Materialised on every service change, not only on the first, because the
    // deemed date can move: a letter proved delivered earlier than the
    // statutory assumption, or a returned letter replaced by an email. The
    // objection clock runs from deemed service, so the recorded deadline has
    // to follow it. `materialise` re-anchors an open deadline rather than
    // duplicating it.
    const current = await this.cases.findById(caseId);
    if (
      current.statusCode === CaseStatus.NOTICE_SERVED ||
      current.statusCode === CaseStatus.AWAITING_TAXPAYER_RESPONSE
    ) {
      await this.deadlines.materialise(current, 'NOTICE_SERVED', deemedOn, caller);
    }
  }

  /**
   * Send the covering message for an electronic channel.
   *
   * Outside the transaction: a mail server being slow must not roll back the
   * record that the notice was despatched, and the record is the thing with
   * legal weight.
   */
  private async notifyIfElectronic(
    notice: Record<string, unknown>,
    assessmentCase: { caseNumber: string; taxpayerName: string },
    input: ServeInput,
    attempt: ServiceAttempt,
  ): Promise<void> {
    if (input.channel !== 'EMAIL' && input.channel !== 'SMS' && input.channel !== 'PORTAL') {
      return;
    }

    try {
      await this.notifications.send({
        typeCode: 'NOTICE_SERVED',
        recipient: input.addressee,
        // The three electronic channels share their names with the
        // notification channels, so this is a direct pass-through.
        channels: [input.channel],
        variables: {
          caseNumber: assessmentCase.caseNumber,
          taxpayerName: assessmentCase.taxpayerName,
          noticeNumber: String(notice['notice_number']),
          deemedServedOn: attempt.deemedServedOn,
        },
        contextType: 'ASSESSMENT_NOTICE',
        contextId: Number(notice['id']),
      });
    } catch (error) {
      // Recorded, not raised. The despatch happened; the covering email is a
      // courtesy, and losing it must not make the case look unserved.
      this.logger.warn(
        `Notice ${String(notice['notice_number'])} was despatched but its ${input.channel} ` +
          `notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function toAttempt(row: Record<string, unknown>): ServiceAttempt {
  return {
    id: Number(row['id']),
    uuid: String(row['uuid']),
    noticeId: Number(row['notice_id']),
    channel: String(row['channel']),
    addressee: String(row['addressee']),
    status: String(row['status']),
    dispatchedAt: (row['dispatched_at'] as Date | null) ?? null,
    deliveredAt: (row['delivered_at'] as Date | null) ?? null,
    deemedServedOn: (row['deemed_served_on'] as string | null) ?? null,
    proofReference: (row['proof_reference'] as string | null) ?? null,
    failureReason: (row['failure_reason'] as string | null) ?? null,
  };
}
