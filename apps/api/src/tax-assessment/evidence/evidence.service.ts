import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';
import {
  EVIDENCE_PROVIDERS,
  EvidenceUnavailableError,
  type EvidencePayload,
  type EvidenceProvider,
  type EvidenceRequest,
} from './evidence-provider';

/** One provider's outcome. A failure is recorded, not thrown away. */
export interface ProviderOutcome {
  readonly providerCode: string;
  readonly descriptionKey: string;
  readonly mandatory: boolean;
  readonly status: 'OK' | 'FAILED' | 'SKIPPED';
  readonly payloadHash?: string;
  readonly itemCount: number;
  readonly failureReason?: string;
  readonly retryable?: boolean;
}

export interface SnapshotResult {
  readonly caseId: number;
  readonly retrievedAt: string;
  readonly providers: readonly ProviderOutcome[];
  readonly itemsWritten: number;
  /** True when every mandatory provider succeeded and the case advanced. */
  readonly dataReady: boolean;
  readonly statusCode: string;
}

/**
 * Builds the evidence snapshot a case is assessed on.
 *
 * Plan reference: V2 sections 8.2 to 8.5.
 *
 * ## What a snapshot is for
 *
 * An assessment is a legal act taken on a set of facts at a point in time. If
 * the facts can shift under the case, then the figure a reviewer approves is
 * not necessarily the figure the assessor computed, and neither can be
 * defended on appeal. So retrieval is an explicit, recorded, hashed event, and
 * once the case leaves preparation the snapshot is frozen.
 *
 * ## Failure is not absence
 *
 * The central rule of this service: a provider that could not be reached is
 * recorded as FAILED, and a case with a failed mandatory provider does not
 * become data-ready. The tempting alternative, treating an unreachable source
 * as "nothing to report", produces an assessment that looks complete and is
 * wrong. See `EvidenceProvider` for the provider side of the contract.
 *
 * ## Why this transitions the case itself
 *
 * `RETRIEVE_DATA` is a SYSTEM-only action in the transition table. No human
 * role holds it, because the status DATA_READY is a statement about whether
 * the data actually arrived, not a claim a caseworker should be able to make
 * by pressing a button.
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    @Inject(EVIDENCE_PROVIDERS) private readonly providers: readonly EvidenceProvider[],
  ) {}

  /**
   * Run every applicable provider and store the result.
   *
   * Providers run concurrently: they are independent reads of unrelated
   * systems, and a slow third-party feed should not hold up the filing store.
   * `allSettled` rather than `all` because one failure must not discard the
   * successes; the whole point is to record what each source said.
   */
  async refresh(caseId: number, caller: RequestContext): Promise<SnapshotResult> {
    const assessmentCase = await this.cases.findById(caseId);
    this.assertNotFrozen(assessmentCase.statusCode);

    const request: EvidenceRequest = {
      caseId,
      taxpayerId: assessmentCase.taxpayerId,
      tin: assessmentCase.tin,
      jurisdictionCode: assessmentCase.jurisdictionCode,
      taxTypeCode: assessmentCase.taxTypeCode,
      assessmentYear: assessmentCase.assessmentYear,
      currencyCode: assessmentCase.currencyCode,
      correlationId: caller.correlationId,
    };

    const applicable = this.providers.filter((provider) => provider.supports(request));
    const settled = await Promise.allSettled(
      applicable.map(async (provider) => ({ provider, payload: await provider.fetch(request) })),
    );

    const outcomes: ProviderOutcome[] = [];
    const payloads: { provider: EvidenceProvider; payload: EvidencePayload }[] = [];

    for (let index = 0; index < settled.length; index += 1) {
      const provider = applicable[index]!;
      const result = settled[index]!;

      if (result.status === 'fulfilled') {
        const payload = result.value.payload;
        payloads.push({ provider, payload });
        outcomes.push({
          providerCode: provider.code,
          descriptionKey: provider.descriptionKey,
          mandatory: provider.mandatory,
          status: 'OK',
          payloadHash: hashPayload(payload),
          itemCount: payload.items.length,
        });
        continue;
      }

      const error: unknown = result.reason;
      const unavailable = error instanceof EvidenceUnavailableError ? error : undefined;
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `Evidence provider ${provider.code} failed for case ${caseId} ` +
          `[${caller.correlationId}]: ${message}`,
      );

      outcomes.push({
        providerCode: provider.code,
        descriptionKey: provider.descriptionKey,
        mandatory: provider.mandatory,
        status: 'FAILED',
        itemCount: 0,
        failureReason: message,
        retryable: unavailable?.retryable ?? true,
      });
    }

    const itemsWritten = await this.persist(caseId, request, outcomes, payloads, caller);

    const mandatoryFailed = outcomes.filter((o) => o.mandatory && o.status === 'FAILED');
    if (mandatoryFailed.length > 0) {
      this.logger.warn(
        `Case ${caseId} stays at ${assessmentCase.statusCode}: mandatory providers failed ` +
          `(${mandatoryFailed.map((o) => o.providerCode).join(', ')}).`,
      );
      return {
        caseId,
        retrievedAt: new Date().toISOString(),
        providers: outcomes,
        itemsWritten,
        dataReady: false,
        statusCode: assessmentCase.statusCode,
      };
    }

    const statusCode = await this.advance(caseId, assessmentCase.statusCode, caller);

    return {
      caseId,
      retrievedAt: new Date().toISOString(),
      providers: outcomes,
      itemsWritten,
      dataReady: true,
      statusCode,
    };
  }

  /**
   * Move the case to DATA_READY, under a SYSTEM identity.
   *
   * The caller's correlation id is carried through so the transition appears
   * on the same trace as the request that triggered it, but the roles are
   * SYSTEM: this transition is the platform asserting that data arrived, and
   * attributing it to the caseworker who pressed refresh would misstate who
   * vouched for it.
   *
   * Re-running retrieval on a case already past INITIATED is legitimate, and
   * there is no transition out of DATA_READY on this action, so the attempt is
   * made only from INITIATED.
   */
  private async advance(
    caseId: number,
    currentStatus: string,
    caller: RequestContext,
  ): Promise<string> {
    if (currentStatus !== CaseStatus.INITIATED) return currentStatus;

    const systemContext: RequestContext = {
      ...caller,
      roleCodes: [RoleCode.SYSTEM],
      correlationId: caller.correlationId || randomUUID(),
    };

    const updated = await this.cases.transition(caseId, 'RETRIEVE_DATA', systemContext, {
      triggeredBy: caller.username ?? 'system',
    });
    return updated.statusCode;
  }

  /**
   * Freeze rule.
   *
   * Once a case is with a reviewer or beyond, the figures have been vouched
   * for. Letting evidence move underneath that would mean the reviewer
   * approved one set of facts and the file records another.
   */
  private assertNotFrozen(statusCode: string): void {
    const open: readonly string[] = [
      CaseStatus.INITIATED,
      CaseStatus.DATA_READY,
      CaseStatus.ASSIGNED,
      CaseStatus.IN_PREPARATION,
      CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    ];
    if (!open.includes(statusCode)) {
      throw new BadRequestException(
        `Evidence is frozen at status ${statusCode}. The assessment has been submitted for ` +
          'review and must be decided on the facts it was prepared from. Reopen the case if ' +
          'the facts have genuinely changed.',
      );
    }
  }

  /**
   * Store the snapshot and rebuild the declared items.
   *
   * One transaction. A half-written snapshot, where the evidence rows landed
   * but the items did not, would calculate against figures nothing explains.
   */
  private async persist(
    caseId: number,
    request: EvidenceRequest,
    outcomes: readonly ProviderOutcome[],
    payloads: readonly { provider: EvidenceProvider; payload: EvidencePayload }[],
    caller: RequestContext,
  ): Promise<number> {
    return this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `UPDATE tax.tax_assessment_evidence SET is_current = false
          WHERE case_id = :caseId AND is_current`,
        { type: QueryTypes.UPDATE, transaction, replacements: { caseId } },
      );

      for (const outcome of outcomes) {
        const found = payloads.find((entry) => entry.provider.code === outcome.providerCode);
        await this.sequelize.query(
          `INSERT INTO tax.tax_assessment_evidence
                  (case_id, source_system, request_json, response_json, payload_hash,
                   retrieved_at, retrieved_by, is_current, created_at)
           VALUES (:caseId, :source, :request, :response, :hash,
                   CURRENT_TIMESTAMP, :userId, true, CURRENT_TIMESTAMP)`,
          {
            type: QueryTypes.INSERT,
            transaction,
            replacements: {
              caseId,
              source: outcome.providerCode,
              request: JSON.stringify({
                taxpayerId: request.taxpayerId,
                taxTypeCode: request.taxTypeCode,
                assessmentYear: request.assessmentYear,
                correlationId: request.correlationId,
              }),
              response: JSON.stringify(
                found === undefined
                  ? { status: outcome.status, failureReason: outcome.failureReason }
                  : serialisePayload(found.payload),
              ),
              // A failed retrieval still gets a hash, of the failure record,
              // so every row in the table has one and the column stays NOT
              // NULL without a sentinel.
              hash: outcome.payloadHash ?? hashObject({ failed: outcome.failureReason ?? '' }),
              userId: caller.userId ?? null,
            },
          },
        );
      }

      return this.rebuildItems(caseId, payloads, caller, transaction);
    });
  }

  /**
   * Replace the declared items with what the providers reported.
   *
   * Deactivated rather than deleted: a figure that disappeared between two
   * retrievals is something a reviewer may need to see. `assessed_amount` and
   * `difference_amount` are left null here because they are the assessor's
   * conclusion, not the source's claim.
   */
  private async rebuildItems(
    caseId: number,
    payloads: readonly { provider: EvidenceProvider; payload: EvidencePayload }[],
    caller: RequestContext,
    transaction: Transaction,
  ): Promise<number> {
    await this.sequelize.query(
      `UPDATE tax.tax_assessment_item
          SET is_active = false, updated_at = CURRENT_TIMESTAMP, updated_by = :userId
        WHERE case_id = :caseId AND is_active AND source <> 'MANUAL'`,
      {
        type: QueryTypes.UPDATE,
        transaction,
        replacements: { caseId, userId: caller.userId ?? null },
      },
    );

    let sequence = 0;
    for (const { payload } of payloads) {
      for (const item of payload.items) {
        sequence += 1;
        await this.sequelize.query(
          `INSERT INTO tax.tax_assessment_item
                  (case_id, concept_code, item_label_key, declared_amount, source, sequence,
                   created_at, created_by, updated_at, updated_by, is_active)
           VALUES (:caseId, :concept, :label, :amount, :source, :sequence,
                   CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)`,
          {
            type: QueryTypes.INSERT,
            transaction,
            replacements: {
              caseId,
              concept: item.conceptCode,
              label: item.labelKey ?? null,
              // toDatabaseValue, not toString: the column is NUMERIC(20,4) and
              // this is the form that round-trips exactly.
              amount: item.declaredAmount.toDatabaseValue(),
              source: item.source,
              sequence,
              userId: caller.userId ?? null,
            },
          },
        );
      }
    }

    return sequence;
  }

  /** The current snapshot, for the evidence panel. */
  async currentFor(caseId: number): Promise<{
    readonly sources: readonly Record<string, unknown>[];
    readonly items: readonly Record<string, unknown>[];
  }> {
    const sources = await this.sequelize.query<Record<string, unknown>>(
      `SELECT source_system, payload_hash, retrieved_at, response_json
         FROM tax.tax_assessment_evidence
        WHERE case_id = :caseId AND is_current
        ORDER BY source_system`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const items = await this.sequelize.query<Record<string, unknown>>(
      `SELECT concept_code, item_label_key, declared_amount::text AS declared_amount,
              assessed_amount::text AS assessed_amount, source, sequence
         FROM tax.tax_assessment_item
        WHERE case_id = :caseId AND is_active
        ORDER BY sequence`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    if (sources.length === 0 && items.length === 0) {
      // Distinguishes "retrieved and found nothing" from "never retrieved".
      // The caller needs to know which, because only one of them is a problem.
      throw new NotFoundException(
        `No evidence has been retrieved for case ${caseId}. Run the evidence refresh first.`,
      );
    }

    return { sources, items };
  }

  /**
   * Losses, credits and payments for the calculation.
   *
   * Read back from the stored snapshot rather than re-fetched, so that two
   * calculations of the same case at the same version see identical inputs
   * even if a source system changed in between.
   */
  async calculationInputsFor(
    caseId: number,
    currencyCode: string,
  ): Promise<{
    readonly losses: readonly { originYear: string; amount: Money }[];
    readonly credits: readonly { code: string; amount: Money }[];
    readonly amountPaid: Money;
    readonly filedOn?: string;
    readonly dueOn?: string;
  }> {
    const rows = await this.sequelize.query<{ response_json: SerialisedPayload | null }>(
      `SELECT response_json
         FROM tax.tax_assessment_evidence
        WHERE case_id = :caseId AND is_current`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const losses: { originYear: string; amount: Money }[] = [];
    const credits: { code: string; amount: Money }[] = [];
    let amountPaid = Money.zero(currencyCode);
    let filedOn: string | undefined;
    let dueOn: string | undefined;

    for (const row of rows) {
      const payload = row.response_json;
      if (payload === null || payload === undefined) continue;

      for (const loss of payload.losses ?? []) {
        losses.push({ originYear: loss.originYear, amount: Money.of(loss.amount, currencyCode) });
      }
      for (const credit of payload.credits ?? []) {
        credits.push({ code: credit.creditCode, amount: Money.of(credit.amount, currencyCode) });
      }
      if (payload.amountPaid !== undefined) {
        amountPaid = amountPaid.add(Money.of(payload.amountPaid, currencyCode));
      }
      filedOn = payload.filedOn ?? filedOn;
      dueOn = payload.dueOn ?? dueOn;
    }

    return { losses, credits, amountPaid, filedOn, dueOn };
  }
}

/** The stored JSON shape. Amounts are strings, as everywhere else. */
interface SerialisedPayload {
  readonly items?: readonly { conceptCode: string; declaredAmount: string; source: string }[];
  readonly losses?: readonly { originYear: string; amount: string }[];
  readonly credits?: readonly { creditCode: string; amount: string; nonRefundable: boolean }[];
  readonly amountPaid?: string;
  readonly filedOn?: string;
  readonly dueOn?: string;
  readonly raw?: Record<string, unknown>;
}

function serialisePayload(payload: EvidencePayload): SerialisedPayload {
  return {
    items: payload.items.map((item) => ({
      conceptCode: item.conceptCode,
      declaredAmount: item.declaredAmount.toDatabaseValue(),
      source: item.source,
    })),
    losses: payload.losses?.map((loss) => ({
      originYear: loss.originYear,
      amount: loss.amount.toDatabaseValue(),
    })),
    credits: payload.credits?.map((credit) => ({
      creditCode: credit.creditCode,
      amount: credit.amount.toDatabaseValue(),
      nonRefundable: credit.nonRefundable,
    })),
    amountPaid: payload.amountPaid?.toDatabaseValue(),
    filedOn: payload.filedOn,
    dueOn: payload.dueOn,
    raw: payload.raw,
  };
}

/**
 * A hash that identifies the facts, not their encoding.
 *
 * Keys are sorted so that two payloads with the same content hash the same
 * regardless of property order, which is what makes the hash usable for
 * "did anything actually change since the last retrieval".
 */
function hashPayload(payload: EvidencePayload): string {
  return hashObject(serialisePayload(payload) as unknown as Record<string, unknown>);
}

function hashObject(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalise(value)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
