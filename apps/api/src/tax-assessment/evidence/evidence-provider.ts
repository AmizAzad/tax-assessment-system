import type { Money } from '@tas/decimal';

/**
 * A source of facts about a taxpayer for a period.
 *
 * Plan reference: V2 sections 8.2, 8.3.
 *
 * ## Why a port rather than direct calls
 *
 * Every jurisdiction has a different set of sources: a filing store, a
 * withholding register, a bank-interest feed, a customs declaration system.
 * The assessment logic must not know which of these exist. It asks the
 * registry for whatever is configured and works with what comes back.
 *
 * ## The contract that matters
 *
 * A provider returns facts or it throws. It must never return zero, an empty
 * list, or a default to signal "I could not reach the source". A zero credit
 * and an unreachable credit register are different situations: the first
 * produces a correct assessment, the second produces a wrong one that looks
 * correct. `EvidenceService` refuses to mark a case data-ready when a
 * mandatory provider threw, which only works if providers are honest about
 * failure.
 */
export interface EvidenceProvider {
  /** Stable identifier, stored in `tax_assessment_evidence.source_system`. */
  readonly code: string;

  /** Shown in the evidence panel so a caseworker knows where a figure came from. */
  readonly descriptionKey: string;

  /**
   * Whether a case may reach DATA_READY without this provider succeeding.
   *
   * A filing store is mandatory: assessing without knowing what was declared
   * is not an assessment. A third-party interest feed is usually not, because
   * its absence narrows the assessment rather than invalidating it.
   */
  readonly mandatory: boolean;

  /** Whether this provider applies to the given case at all. */
  supports(request: EvidenceRequest): boolean;

  fetch(request: EvidenceRequest): Promise<EvidencePayload>;
}

export interface EvidenceRequest {
  readonly caseId: number;
  readonly taxpayerId: number;
  readonly tin: string;
  readonly jurisdictionCode: string;
  readonly taxTypeCode: string;
  readonly assessmentYear: string;
  readonly currencyCode: string;
  readonly correlationId: string;
}

/**
 * What a provider returns.
 *
 * Amounts are `Money`, never numbers: a provider that reads JSON must convert
 * from the string form, and the type system will not let it pass a float
 * through (ADR-007).
 */
export interface EvidencePayload {
  /**
   * Figures as the taxpayer declared them, or as a third party reported them.
   * `concept_code` is the jurisdiction's line-item vocabulary, for example
   * `TRADING_PROFIT` or `INTEREST_RECEIVED`.
   */
  readonly items: readonly EvidenceItem[];

  /** Losses available to set off, oldest first. */
  readonly losses?: readonly EvidenceLoss[];

  /** Credits already suffered: withholding, foreign tax, advance payments. */
  readonly credits?: readonly EvidenceCredit[];

  /** Tax already paid against this period. */
  readonly amountPaid?: Money;

  /** When the return was filed, for the late-filing penalty. Absent means not filed. */
  readonly filedOn?: string;

  /** When the tax fell due, for interest. */
  readonly dueOn?: string;

  /** Anything the provider wants preserved in the snapshot but does not model. */
  readonly raw?: Record<string, unknown>;
}

export interface EvidenceItem {
  readonly conceptCode: string;
  readonly labelKey?: string;
  readonly declaredAmount: Money;
  /**
   * `FILED` for a taxpayer declaration, `THIRD_PARTY` for externally reported,
   * `SYSTEM` for something the platform derived.
   */
  readonly source: 'FILED' | 'THIRD_PARTY' | 'SYSTEM';
}

export interface EvidenceLoss {
  readonly originYear: string;
  readonly amount: Money;
}

export interface EvidenceCredit {
  readonly creditCode: string;
  readonly amount: Money;
  /** A credit that cannot create a repayment, only reduce liability to nil. */
  readonly nonRefundable: boolean;
}

/**
 * Thrown by a provider that could not obtain the facts.
 *
 * Distinguishes "the source says there is nothing" from "I could not ask".
 */
export class EvidenceUnavailableError extends Error {
  constructor(
    readonly providerCode: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EvidenceUnavailableError';
  }
}

/** DI token for the provider list. */
export const EVIDENCE_PROVIDERS = Symbol('EVIDENCE_PROVIDERS');
