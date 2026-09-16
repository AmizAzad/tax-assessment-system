import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RoundingMode } from '@tas/decimal';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { currentUserId } from '../../platform/auth/request-context';
import { CalculationError, CalculationStep, type RuleItem, type RuleSet } from './types';

/**
 * Versioned, effective-dated tax rule sets.
 *
 * Plan reference: V2 sections 15.3, 27.3; ADR-006.
 *
 * ## Why publication needs two people
 *
 * A wrong rate does not affect one case. It affects every case computed after
 * it is published, silently, until someone notices. The plan requires dual
 * control in production and this enforces it in code: the author may not be
 * the publisher.
 *
 * ## Why overlapping effective dates are impossible
 *
 * The database carries an exclusion constraint, so two published sets cannot
 * cover the same jurisdiction, tax type and date. Without it, which rate
 * applied would depend on which row a query happened to return first — and
 * that is a wrong assessment waiting to happen.
 */
@Injectable()
export class RuleSetService {
  private readonly logger = new Logger(RuleSetService.name);

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * The rule set in force for a jurisdiction, tax type and date.
   *
   * The date is the *period* being assessed, not today: an assessment for 2024
   * is computed under the rules that applied in 2024, however many times the
   * rates have changed since.
   */
  async resolve(
    jurisdictionCode: string,
    taxTypeCode: string,
    effectiveOn: string,
  ): Promise<RuleSet> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, code, version, jurisdiction_code, tax_type_code, currency_code,
              rounding_scale, rounding_mode
         FROM tax.tax_rule_set
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND status = 'PUBLISHED'
          AND is_active
          AND effective_from <= :effectiveOn
          AND (effective_to IS NULL OR effective_to > :effectiveOn)`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode, taxType: taxTypeCode, effectiveOn },
      },
    );

    if (rows.length === 0) {
      throw new CalculationError(
        `No published rule set covers ${taxTypeCode} in ${jurisdictionCode} on ${effectiveOn}. ` +
          `A liability cannot be computed without one.`,
        CalculationStep.RATE_APPLICATION,
        'NO_EFFECTIVE_RULE',
      );
    }

    if (rows.length > 1) {
      // The exclusion constraint should make this impossible. If it happens,
      // something has bypassed the database and guessing would be worse than
      // failing.
      throw new CalculationError(
        `${rows.length} published rule sets cover ${taxTypeCode} in ${jurisdictionCode} on ` +
          `${effectiveOn}. Refusing to guess which applies.`,
        CalculationStep.RATE_APPLICATION,
        'AMBIGUOUS_RULE',
      );
    }

    return this.hydrate(rows[0]!);
  }

  async findById(id: number): Promise<RuleSet> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, code, version, jurisdiction_code, tax_type_code, currency_code,
              rounding_scale, rounding_mode
         FROM tax.tax_rule_set WHERE id = :id AND is_active`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such rule set');
    }
    return this.hydrate(row);
  }

  async list(jurisdictionCode?: string): Promise<
    Array<{
      id: number;
      code: string;
      version: number;
      jurisdictionCode: string;
      taxTypeCode: string;
      status: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      itemCount: number;
    }>
  > {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT r.id, r.code, r.version, r.jurisdiction_code, r.tax_type_code, r.status,
              r.effective_from, r.effective_to,
              (SELECT count(*) FROM tax.tax_rule_set_item i WHERE i.rule_set_id = r.id) AS item_count
         FROM tax.tax_rule_set r
        WHERE r.is_active
          AND (:jurisdiction::text IS NULL OR r.jurisdiction_code = :jurisdiction)
        ORDER BY r.jurisdiction_code, r.tax_type_code, r.effective_from DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode ?? null },
      },
    );

    return rows.map((row) => ({
      id: Number(row['id']),
      code: String(row['code']),
      version: Number(row['version']),
      jurisdictionCode: String(row['jurisdiction_code']),
      taxTypeCode: String(row['tax_type_code']),
      status: String(row['status']),
      effectiveFrom: String(row['effective_from']),
      effectiveTo: row['effective_to'] === null ? null : String(row['effective_to']),
      itemCount: Number(row['item_count']),
    }));
  }

  /**
   * Publish a draft.
   *
   * @throws ForbiddenException when the caller authored it. Dual control is
   *         the single most valuable safeguard against a bad rate change
   *         (plan 15.3), and it is worthless if the author can wave their own
   *         work through.
   */
  async publish(id: number): Promise<{ id: number; status: string }> {
    const rows = await this.sequelize.query<{
      status: string;
      authored_by: string | null;
      code: string;
    }>(`SELECT status, authored_by, code FROM tax.tax_rule_set WHERE id = :id`, {
      type: QueryTypes.SELECT,
      replacements: { id },
    });
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such rule set');
    }
    if (row.status === 'PUBLISHED') {
      return { id, status: 'PUBLISHED' };
    }
    if (row.status === 'ARCHIVED') {
      throw new ConflictException('An archived rule set cannot be republished');
    }

    const publisher = currentUserId();
    if (row.authored_by !== null && publisher !== null && Number(row.authored_by) === publisher) {
      throw new ForbiddenException(
        'A rule set must be published by someone other than its author. A wrong rate affects ' +
          'every case computed after it, so this needs a second pair of eyes.',
      );
    }

    const items = await this.itemsFor(id);
    if (items.length === 0) {
      throw new BadRequestException('A rule set with no rules cannot be published');
    }
    if (!items.some((item) => item.itemType === 'RATE_BAND')) {
      throw new BadRequestException(
        'A rule set with no rate band cannot compute a liability and cannot be published',
      );
    }

    try {
      await this.sequelize.query(
        `UPDATE tax.tax_rule_set
            SET status = 'PUBLISHED',
                published_by = :publisher,
                published_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = :id`,
        { type: QueryTypes.UPDATE, replacements: { id, publisher: publisher ?? null } },
      );
    } catch (error) {
      // The exclusion constraint fires here when the new set overlaps one
      // already in force. That is a configuration error worth explaining.
      const message = error instanceof Error ? error.message : '';
      if (message.includes('tax_rule_set_no_overlap')) {
        throw new ConflictException(
          'This rule set overlaps one already in force for the same jurisdiction, tax type ' +
            'and dates. End the existing set first, so it is unambiguous which rules apply.',
        );
      }
      throw error;
    }

    this.logger.log(`Published rule set ${row.code} (id ${id})`);
    return { id, status: 'PUBLISHED' };
  }

  private async hydrate(row: Record<string, unknown>): Promise<RuleSet> {
    const id = Number(row['id']);
    return {
      id,
      code: String(row['code']),
      version: Number(row['version']),
      jurisdictionCode: String(row['jurisdiction_code']),
      taxTypeCode: String(row['tax_type_code']),
      currencyCode: String(row['currency_code']),
      rounding: {
        scale: Number(row['rounding_scale']),
        mode: toRoundingMode(String(row['rounding_mode'])),
      },
      items: await this.itemsFor(id),
    };
  }

  private async itemsFor(ruleSetId: number): Promise<readonly RuleItem[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT i.item_type, i.sequence, i.parameters_json, i.description_key, r.code
         FROM tax.tax_rule_set_item i
         JOIN tax.tax_rule_set r ON r.id = i.rule_set_id
        WHERE i.rule_set_id = :ruleSetId AND i.is_active
        ORDER BY i.item_type, i.sequence`,
      { type: QueryTypes.SELECT, replacements: { ruleSetId } },
    );

    return rows.map((row) => ({
      itemType: String(row['item_type']) as RuleItem['itemType'],
      sequence: Number(row['sequence']),
      parameters: row['parameters_json'] as Record<string, unknown>,
      descriptionKey: row['description_key'] === null ? undefined : String(row['description_key']),
      reference: `${String(row['code'])}/${String(row['item_type'])}/${String(row['sequence'])}`,
    }));
  }
}

/**
 * Map a stored rounding mode.
 *
 * Refuses an unknown value rather than defaulting: silently rounding HALF_UP
 * when the statute says HALF_EVEN is a wrong liability, systematically.
 */
function toRoundingMode(stored: string): RoundingMode {
  const mode = (RoundingMode as Record<string, RoundingMode>)[stored];
  if (mode === undefined) {
    throw new BadRequestException(
      `Rule set specifies rounding mode '${stored}', which this build does not know. ` +
        `Defaulting would compute a wrong liability.`,
    );
  }
  return mode;
}
