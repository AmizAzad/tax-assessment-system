import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';

export interface DepositAssessment {
  readonly required: boolean;
  readonly amount: string | null;
  readonly currencyCode: string;
  readonly paid: string;
  readonly outstanding: string | null;
  readonly staysCollection: boolean;
  /** How the figure was arrived at, for the taxpayer who has to find the money. */
  readonly derivation: string;
}

/**
 * The deposit some jurisdictions require before an objection is heard.
 *
 * Plan reference: V2 section 13.2, open question Q14.
 *
 * ## Why a jurisdiction with no rule requires nothing
 *
 * The absence of a configured rule means no deposit. That is the only safe
 * default: inventing one would put a financial barrier in front of a statutory
 * right, and a taxpayer refused a hearing over a deposit the law never
 * demanded has a complaint the authority cannot answer.
 *
 * The United Kingdom has no rule configured; Saudi Arabia requires ten per cent
 * of the disputed amount. Both are data.
 *
 * ## Why the deposit does not gate admissibility here
 *
 * An unpaid deposit moves the objection to AWAITING_DEPOSIT. It does not make
 * the objection inadmissible, because whether to hear an objection where the
 * deposit is late or waived is a person's decision, exactly like lateness.
 */
@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * What this objection must deposit, if anything.
   *
   * The disputed amount is the relief the taxpayer asked for, falling back to
   * the assessed net where they did not quantify it. Falling back matters:
   * many objections say "the assessment is wrong" without naming a figure, and
   * a deposit of nothing would then be required on the largest disputes.
   */
  async assess(objectionUuid: string): Promise<DepositAssessment> {
    const objection = await this.load(objectionUuid);
    const currency = String(objection['currency_code'] ?? objection['case_currency'] ?? 'GBP');

    const rule = await this.ruleFor(
      String(objection['jurisdiction_code']),
      String(objection['tax_type_code']),
    );

    const paid = Money.of(String(objection['deposit_paid'] ?? '0'), currency);

    if (rule === undefined) {
      return {
        required: false,
        amount: null,
        currencyCode: currency,
        paid: paid.toFixed(2),
        outstanding: null,
        staysCollection: false,
        derivation: 'No deposit is required for objections in this jurisdiction.',
      };
    }

    const disputed = Money.of(
      String(objection['requested_relief'] ?? objection['net_payable'] ?? '0'),
      currency,
    );

    let amount = disputed.multiply(Money.rate(String(rule.percent_of_disputed)));
    const parts: string[] = [
      `${(Number(rule.percent_of_disputed) * 100).toFixed(2)}% of ${disputed.toFixed(2)} = ${amount.toFixed(2)}`,
    ];

    if (rule.minimum_amount !== null) {
      const minimum = Money.of(rule.minimum_amount, currency);
      if (amount.lessThan(minimum)) {
        amount = minimum;
        parts.push(`raised to the minimum of ${minimum.toFixed(2)}`);
      }
    }
    if (rule.maximum_amount !== null) {
      const maximum = Money.of(rule.maximum_amount, currency);
      if (amount.greaterThan(maximum)) {
        amount = maximum;
        parts.push(`capped at the maximum of ${maximum.toFixed(2)}`);
      }
    }

    const outstanding = amount.subtract(paid);

    return {
      required: true,
      amount: amount.toFixed(2),
      currencyCode: currency,
      paid: paid.toFixed(2),
      outstanding: outstanding.isNegative() ? '0.00' : outstanding.toFixed(2),
      staysCollection: rule.stays_collection,
      derivation: parts.join(', '),
    };
  }

  /**
   * Record a deposit payment against an objection.
   *
   * Writes the required figure alongside the paid one, so the objection record
   * says what was demanded as well as what arrived. Recomputing the demand
   * later could give a different answer if the rule changed.
   */
  async record(
    objectionUuid: string,
    amount: string,
    caller: RequestContext,
  ): Promise<DepositAssessment> {
    const objection = await this.load(objectionUuid);

    if (objection['status'] === 'DECIDED') {
      throw new ConflictException(
        'The objection has already been decided; a deposit no longer serves any purpose.',
      );
    }

    const before = await this.assess(objectionUuid);
    if (!before.required) {
      throw new BadRequestException(
        'No deposit is required for objections in this jurisdiction, so none can be recorded ' +
          'against this one.',
      );
    }

    const currency = before.currencyCode;
    const payment = Money.of(amount, currency);
    if (!payment.isPositive()) {
      throw new BadRequestException('A deposit must be a positive amount.');
    }

    const total = Money.of(before.paid, currency).add(payment);
    const required = Money.of(before.amount!, currency);
    const settled = total.greaterThanOrEqual(required);

    await this.sequelize.query(
      `UPDATE tax.tax_objection
          SET deposit_required = :required,
              deposit_paid = :paid,
              collection_stayed = CASE WHEN :settled AND :stays THEN true ELSE collection_stayed END,
              status = CASE WHEN :settled AND status = 'AWAITING_DEPOSIT'
                            THEN 'UNDER_CONSIDERATION'
                            WHEN NOT :settled AND status = 'FILED'
                            THEN 'AWAITING_DEPOSIT'
                            ELSE status END,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = :userId
        WHERE id = :id`,
      {
        type: QueryTypes.UPDATE,
        replacements: {
          id: Number(objection['id']),
          required: required.toDatabaseValue(),
          paid: total.toDatabaseValue(),
          settled,
          stays: before.staysCollection,
          userId: caller.userId ?? null,
        },
      },
    );

    this.logger.log(
      `Objection ${String(objection['objection_number'])}: deposit ${total.toFixed(2)} of ` +
        `${required.toFixed(2)} ${currency}${settled ? ' (satisfied)' : ''}`,
    );

    return this.assess(objectionUuid);
  }

  // ------------------------------------------------------------------ internals

  private async load(uuid: string): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT o.*, c.jurisdiction_code, c.tax_type_code,
              c.currency_code AS case_currency,
              r.net_payable_or_refundable::text AS net_payable
         FROM tax.tax_objection o
         JOIN tax.tax_assessment_case c ON c.id = o.case_id
         LEFT JOIN tax.tax_calculation_result r ON r.case_id = c.id AND r.is_current
        WHERE o.uuid = :uuid AND o.is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Objection ${uuid} was not found.`);
    }
    return row;
  }

  private async ruleFor(
    jurisdictionCode: string,
    taxTypeCode: string,
  ): Promise<
    | {
        percent_of_disputed: string;
        minimum_amount: string | null;
        maximum_amount: string | null;
        stays_collection: boolean;
      }
    | undefined
  > {
    const rows = await this.sequelize.query<{
      percent_of_disputed: string;
      minimum_amount: string | null;
      maximum_amount: string | null;
      stays_collection: boolean;
    }>(
      `SELECT percent_of_disputed::text AS percent_of_disputed,
              minimum_amount::text AS minimum_amount,
              maximum_amount::text AS maximum_amount,
              stays_collection
         FROM tax.tax_objection_deposit_rule
        WHERE jurisdiction_code = :jurisdiction
          AND (tax_type_code IS NULL OR tax_type_code = :taxType)
          AND is_active
        ORDER BY tax_type_code NULLS LAST
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode, taxType: taxTypeCode },
      },
    );
    return rows[0];
  }
}
