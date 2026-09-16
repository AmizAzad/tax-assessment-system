import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { SettlementService } from '../lifecycle/settlement.service';

export interface RecordAccountEntry {
  readonly entryType: string;
  readonly taxTypeCode: string;
  readonly assessmentYear: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly valueDate: string;
  readonly creditCode?: string;
  readonly nonRefundable?: boolean;
  readonly sourceReference?: string;
  readonly narrative?: string;
}

/**
 * Payments, credits and losses held against a taxpayer.
 *
 * Plan reference: V2 section 9.4.
 *
 * ## Why writes are so constrained
 *
 * Every row here reduces somebody's tax. A payment that was never made and a
 * credit that was never suffered both produce a smaller assessment, and
 * neither leaves a trace in the case file where a reviewer would look. So
 * manual entry is FULL-level, carries a mandatory provenance, and cannot
 * overwrite an existing entry.
 *
 * In a live deployment most rows arrive from a banking or withholding feed
 * rather than through this service; the manual path exists for corrections and
 * for the cases every revenue authority has where a payment was made in a way
 * the automated feed cannot see.
 */
@Injectable()
export class AccountService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly settlement: SettlementService,
  ) {}

  async record(
    taxpayerId: number,
    input: RecordAccountEntry,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    // Parsing through Money rather than trusting the regex alone: this is what
    // rejects "1.00000" against a 4-decimal currency and normalises the form
    // that reaches the column.
    const amount = Money.of(input.amount, input.currencyCode);

    if (!amount.isPositive()) {
      // The CHECK constraint enforces this too. Catching it here gives a
      // message that says what to do instead.
      throw new BadRequestException(
        'Amount must be positive. A refund or a reversal is its own entry with its own ' +
          'provenance, not a negative payment.',
      );
    }

    const isCredit =
      input.entryType === 'WITHHOLDING_CREDIT' || input.entryType === 'FOREIGN_TAX_CREDIT';
    if (isCredit && (input.creditCode === undefined || input.creditCode === '')) {
      throw new BadRequestException(
        'A credit needs a creditCode so it can be traced to the rule that allows it.',
      );
    }

    try {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.taxpayer_account_entry
                (taxpayer_id, tax_type_code, assessment_year, entry_type, credit_code,
                 amount, currency_code, is_non_refundable, value_date,
                 source_system, source_reference, narrative,
                 created_at, created_by, updated_at, updated_by, is_active)
         VALUES (:taxpayerId, :taxType, :year, :entryType, :creditCode,
                 :amount, :currency, :nonRefundable, :valueDate,
                 'MANUAL', :sourceReference, :narrative,
                 CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
         RETURNING id, entry_type, amount::text AS amount, currency_code, value_date::text AS value_date`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            taxpayerId,
            taxType: input.taxTypeCode,
            year: input.assessmentYear,
            entryType: input.entryType,
            creditCode: input.creditCode ?? null,
            amount: amount.toDatabaseValue(),
            currency: input.currencyCode,
            nonRefundable: input.nonRefundable ?? false,
            valueDate: input.valueDate.slice(0, 10),
            sourceReference: input.sourceReference ?? null,
            narrative: input.narrative ?? null,
            userId: caller.userId ?? null,
          },
        },
      );
      const recorded = rows[0] ?? {};

      // A payment that clears the balance settles the case. Evaluated here
      // rather than waiting for a nightly sweep, because a taxpayer who has
      // just paid should not see an outstanding demand.
      const settlements =
        input.entryType === 'PAYMENT' || input.entryType === 'ADVANCE_PAYMENT'
          ? await this.settlement.evaluatePeriod(
              taxpayerId,
              input.taxTypeCode,
              input.assessmentYear,
              caller,
            )
          : [];

      return { ...recorded, settlements };
    } catch (error) {
      // The partial unique index on (source_system, source_reference) is what
      // stops the same bank reference being credited twice.
      //
      // Matched on the constraint name the driver reports, not on the message
      // text. Sequelize wraps the driver error and its own `message` does not
      // carry the index name, so a substring test against it silently never
      // matched and the duplicate surfaced as a 500.
      if (constraintNameOf(error) === 'ux_account_entry_source') {
        throw new ConflictException(
          `An entry with source reference ${input.sourceReference} already exists. ` +
            'Recording it again would credit the same money twice.',
        );
      }
      throw error;
    }
  }

  /**
   * Everything held for a taxpayer, grouped by period.
   *
   * Totals are computed in SQL and returned as text. Summing in JavaScript
   * would be equally exact through Money, but the aggregate is wanted per
   * period and the database groups it in one pass.
   */
  async summaryFor(taxpayerId: number): Promise<Record<string, unknown>> {
    const entries = await this.sequelize.query<Record<string, unknown>>(
      `SELECT tax_type_code, assessment_year, entry_type, credit_code,
              amount::text AS amount, currency_code, is_non_refundable,
              value_date::text AS value_date, source_system, source_reference
         FROM tax.taxpayer_account_entry
        WHERE taxpayer_id = :taxpayerId AND is_active
        ORDER BY assessment_year DESC, value_date, id`,
      { type: QueryTypes.SELECT, replacements: { taxpayerId } },
    );

    const losses = await this.sequelize.query<Record<string, unknown>>(
      `SELECT tax_type_code, origin_year, loss_type,
              original_amount::text AS original_amount,
              consumed_amount::text AS consumed_amount,
              (original_amount - consumed_amount)::text AS remaining_amount,
              currency_code, expires_after_year, established_by_case_id
         FROM tax.taxpayer_loss
        WHERE taxpayer_id = :taxpayerId AND is_active
        ORDER BY origin_year`,
      { type: QueryTypes.SELECT, replacements: { taxpayerId } },
    );

    return { taxpayerId, entries, losses };
  }
}

/**
 * The database constraint a failed write violated, if any.
 *
 * Sequelize nests the driver error under `original` (or `parent`), and only
 * that inner object carries `constraint`. Reading it is the difference between
 * a precise 409 and an opaque 500.
 */
function constraintNameOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidates = [
    error,
    (error as { original?: unknown }).original,
    (error as { parent?: unknown }).parent,
  ];
  for (const candidate of candidates) {
    const name = (candidate as { constraint?: unknown } | undefined)?.constraint;
    if (typeof name === 'string') return name;
  }
  return undefined;
}
