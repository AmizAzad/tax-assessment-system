import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import {
  EvidenceUnavailableError,
  type EvidenceCredit,
  type EvidenceLoss,
  type EvidencePayload,
  type EvidenceProvider,
  type EvidenceRequest,
} from './evidence-provider';

interface AccountRow {
  readonly entry_type: string;
  readonly credit_code: string | null;
  readonly amount: string;
  readonly currency_code: string;
  readonly is_non_refundable: boolean;
  readonly value_date: string;
}

interface LossRow {
  readonly origin_year: string;
  readonly remaining: string;
  readonly currency_code: string;
}

/**
 * Payments, credits and losses held against the taxpayer.
 *
 * Plan reference: V2 sections 8.2, 9.4.
 *
 * ## Why mandatory
 *
 * Missing a payment overstates what is owed; missing a credit does the same.
 * Both produce a demand for money that is not due, and the taxpayer is the one
 * who finds out. An unreachable account store must stop the case, not quietly
 * assess as though nothing had been paid.
 *
 * ## Amounts are read as text
 *
 * `::text` in the projection, not a numeric cast. The Postgres driver hands
 * back NUMERIC as a string precisely so exactness survives, and casting in SQL
 * makes that explicit rather than depending on driver configuration (ADR-007).
 *
 * ## Losses come out oldest first
 *
 * Set-off order is not cosmetic. Where a jurisdiction time-limits carry
 * forward, consuming a newer loss first can strand an older one that then
 * expires unused. Oldest first is the general rule and the one the pipeline
 * assumes, so the ordering is applied here where the rule is visible rather
 * than left to whatever order the rows happen to arrive in.
 */
@Injectable()
export class AccountEvidenceProvider implements EvidenceProvider {
  readonly code = 'TAXPAYER_ACCOUNT';
  readonly descriptionKey = 'evidence.source.taxpayerAccount';
  readonly mandatory = true;

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  supports(): boolean {
    return true;
  }

  async fetch(request: EvidenceRequest): Promise<EvidencePayload> {
    const [entries, losses] = await Promise.all([
      this.loadEntries(request),
      this.loadLosses(request),
    ]);

    const wrongCurrency = entries.find((row) => row.currency_code !== request.currencyCode);
    if (wrongCurrency !== undefined) {
      // Converting here would bury an FX rate inside evidence retrieval, where
      // nobody would ever find it. A mixed-currency account needs a deliberate
      // translation step with its own rate and its own audit trail.
      throw new EvidenceUnavailableError(
        this.code,
        `Account holds ${wrongCurrency.currency_code} entries but the case is assessed in ` +
          `${request.currencyCode}. Currency translation is not automatic.`,
        false,
      );
    }

    const credits: EvidenceCredit[] = [];
    let paid = Money.zero(request.currencyCode);

    for (const row of entries) {
      const amount = Money.of(row.amount, row.currency_code);
      if (row.entry_type === 'PAYMENT' || row.entry_type === 'ADVANCE_PAYMENT') {
        paid = paid.add(amount);
      } else {
        credits.push({
          // The constraint guarantees a code on credit rows, so this is a
          // schema violation rather than a missing value if it fires.
          creditCode: row.credit_code ?? 'UNCODED_CREDIT',
          amount,
          nonRefundable: row.is_non_refundable,
        });
      }
    }

    const lossInputs: EvidenceLoss[] = losses.map((row) => ({
      originYear: row.origin_year,
      amount: Money.of(row.remaining, row.currency_code),
    }));

    return {
      items: [],
      losses: lossInputs,
      credits,
      amountPaid: paid,
      raw: {
        entryCount: entries.length,
        lossCount: lossInputs.length,
      },
    };
  }

  private async loadEntries(request: EvidenceRequest): Promise<readonly AccountRow[]> {
    return this.sequelize.query<AccountRow>(
      `SELECT entry_type,
              credit_code,
              amount::text AS amount,
              currency_code,
              is_non_refundable,
              value_date::text AS value_date
         FROM tax.taxpayer_account_entry
        WHERE taxpayer_id = :taxpayerId
          AND tax_type_code = :taxType
          AND assessment_year = :year
          AND is_active
        ORDER BY value_date, id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          taxpayerId: request.taxpayerId,
          taxType: request.taxTypeCode,
          year: request.assessmentYear,
        },
      },
    );
  }

  /**
   * Losses with something left in them, oldest first.
   *
   * Filtered on the remaining balance rather than on the original, so a fully
   * consumed loss does not appear as an available nil and clutter the trace.
   *
   * `expires_after_year` is compared as text because assessment years are
   * strings like `2024` or `2024-25`; a numeric cast would break the second
   * form. Lexical comparison is correct for both as long as a jurisdiction
   * does not mix the two formats, which the year format is per-jurisdiction
   * configuration precisely to prevent.
   */
  private async loadLosses(request: EvidenceRequest): Promise<readonly LossRow[]> {
    return this.sequelize.query<LossRow>(
      `SELECT origin_year,
              (original_amount - consumed_amount)::text AS remaining,
              currency_code
         FROM tax.taxpayer_loss
        WHERE taxpayer_id = :taxpayerId
          AND tax_type_code = :taxType
          AND origin_year < :year
          AND (expires_after_year IS NULL OR expires_after_year >= :year)
          AND original_amount > consumed_amount
          AND is_active
        ORDER BY origin_year, id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          taxpayerId: request.taxpayerId,
          taxType: request.taxTypeCode,
          year: request.assessmentYear,
        },
      },
    );
  }
}
