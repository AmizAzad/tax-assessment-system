import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';

export interface SelectionRequest {
  readonly jurisdictionCode: string;
  readonly taxTypeCode: string;
  readonly assessmentYear: string;
  /** Candidates scoring at or above this are selected. */
  readonly scoreThreshold?: number;
  /** Cap on how many cases may be opened from this run. */
  readonly maxCases?: number;
}

export interface Candidate {
  readonly taxpayerId: number;
  readonly tin: string;
  readonly name: string;
  readonly totalScore: number;
  readonly matchedRules: readonly { ruleCode: string; weight: number; detail: string }[];
  readonly selected: boolean;
  readonly suppressedReason?: string;
}

/**
 * Deciding who to assess.
 *
 * Plan reference: V2 sections 8.1, 8.2 stage 1 (Phase 2 / Phase 6).
 *
 * ## Why this exists
 *
 * Until now every case had to be opened by hand. That is fine for a
 * demonstration and impossible for an authority with a million registered
 * taxpayers: somebody has to decide which of them are worth looking at, and
 * that decision should be a recorded, repeatable, explainable rule rather than
 * an officer's hunch.
 *
 * ## Rules name indicators; they do not carry SQL
 *
 * `tax_risk_rule.indicator_code` names a check implemented here, and
 * `parameters_json` tunes it. A rule table that accepted arbitrary SQL would
 * be remote code execution wearing a configuration costume, and a tax register
 * is the last database in which to build one.
 *
 * Adding a genuinely new *kind* of indicator is therefore a code change. That
 * is the deliberate boundary: thresholds, weights and combinations are
 * configuration; the meaning of an indicator is not.
 *
 * ## Scoring is advisory
 *
 * A run produces candidates and scores. Opening the cases is a separate,
 * FULL-level act, and a supervisor can see exactly which rules fired on each
 * taxpayer before committing. Selection that opened cases automatically would
 * put the authority's discretion in a cron job.
 */
@Injectable()
export class SelectionService {
  private readonly logger = new Logger(SelectionService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
  ) {}

  /**
   * Score every registered taxpayer in the jurisdiction for a period.
   *
   * Candidates are stored so the run can be explained months later, when
   * somebody asks why a particular company was picked.
   */
  async run(
    request: SelectionRequest,
    caller: RequestContext,
  ): Promise<{ runId: number; candidates: readonly Candidate[]; threshold: number }> {
    const rules = await this.rulesFor(request);
    if (rules.length === 0) {
      throw new BadRequestException(
        `No risk rules are configured for ${request.jurisdictionCode} ${request.taxTypeCode}. ` +
          'Selection would score every taxpayer zero.',
      );
    }

    const threshold = request.scoreThreshold ?? 30;
    const taxpayers = await this.taxpayersIn(request);

    const runId = await this.createRun(request, threshold, rules.length, caller);
    const candidates: Candidate[] = [];

    for (const taxpayer of taxpayers) {
      const matched: { ruleCode: string; weight: number; detail: string }[] = [];
      let score = 0;
      let mandatory = false;

      for (const rule of rules) {
        const hit = await this.evaluate(rule, taxpayer, request);
        if (hit === undefined) continue;
        matched.push({ ruleCode: rule.rule_code, weight: rule.weight, detail: hit });
        score += rule.weight;
        if (rule.is_mandatory_referral) mandatory = true;
      }

      // An existing live case suppresses the candidate. Selecting a taxpayer
      // who is already under assessment would open a duplicate that the case
      // service would refuse anyway, and the refusal is more useful recorded
      // here than raised later.
      const existing = await this.liveCaseFor(taxpayer.id, request);
      const suppressed =
        existing !== undefined
          ? `Already under assessment as ${existing} for this period.`
          : undefined;

      const selected = suppressed === undefined && (mandatory || score >= threshold);

      await this.sequelize.query(
        `INSERT INTO tax.tax_selection_candidate
                (selection_run_id, taxpayer_id, tax_type_code, assessment_year,
                 total_score, matched_rules_json, selected, suppressed_reason,
                 created_at, is_active)
         VALUES (:runId, :taxpayerId, :taxType, :year,
                 :score, :matched, :selected, :suppressed, CURRENT_TIMESTAMP, true)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            runId,
            taxpayerId: taxpayer.id,
            taxType: request.taxTypeCode,
            year: request.assessmentYear,
            score,
            matched: JSON.stringify(matched),
            selected,
            suppressed: suppressed ?? null,
          },
        },
      );

      candidates.push({
        taxpayerId: taxpayer.id,
        tin: taxpayer.tin,
        name: taxpayer.name,
        totalScore: score,
        matchedRules: matched,
        selected,
        suppressedReason: suppressed,
      });
    }

    const chosen = candidates.filter((c) => c.selected).length;

    await this.sequelize.query(
      `UPDATE tax.tax_assessment_selection_run
          SET candidate_count = :evaluated, selected_count = :selected,
              status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
        WHERE id = :runId`,
      {
        type: QueryTypes.UPDATE,
        replacements: { runId, evaluated: candidates.length, selected: chosen },
      },
    );

    this.logger.log(
      `Selection run ${runId}: scored ${candidates.length} taxpayers, ${chosen} above threshold ${threshold}`,
    );

    return {
      runId,
      threshold,
      candidates: [...candidates].sort((a, b) => b.totalScore - a.totalScore),
    };
  }

  /**
   * Open cases for the selected candidates.
   *
   * Separate from the run, and FULL-level, because this is the act that
   * commits the authority to assessing people. `maxCases` is honoured strictly:
   * a run that selected more than an office can work should open what it can
   * and say so, not silently flood the register.
   */
  async openCases(
    runId: number,
    maxCases: number,
    caller: RequestContext,
  ): Promise<{ opened: number; skipped: number; caseNumbers: readonly string[] }> {
    const rows = await this.sequelize.query<{
      id: string;
      taxpayer_id: string;
      tax_type_code: string;
      assessment_year: string;
    }>(
      `SELECT c.id::text AS id, c.taxpayer_id::text AS taxpayer_id,
              c.tax_type_code, c.assessment_year
         FROM tax.tax_selection_candidate c
        WHERE c.selection_run_id = :runId
          AND c.selected
          AND c.case_id IS NULL
          AND c.is_active
        ORDER BY c.total_score DESC
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { runId, limit: Math.min(maxCases, 1000) } },
    );

    const caseNumbers: string[] = [];
    let skipped = 0;

    for (const row of rows) {
      try {
        const created = await this.cases.create(
          {
            taxpayerId: Number(row.taxpayer_id),
            taxTypeCode: row.tax_type_code,
            assessmentYear: row.assessment_year,
            assessmentType: 'DESK',
            triggerPath: 'RISK',
          },
          caller,
        );

        await this.sequelize.query(
          `UPDATE tax.tax_selection_candidate SET case_id = :caseId WHERE id = :id`,
          { type: QueryTypes.UPDATE, replacements: { caseId: created.id, id: row.id } },
        );
        caseNumbers.push(created.caseNumber);
      } catch (error) {
        // Usually a case opened between the run and now. Recorded on the
        // candidate rather than aborting the batch.
        skipped += 1;
        await this.sequelize.query(
          `UPDATE tax.tax_selection_candidate
              SET suppressed_reason = :reason, selected = false
            WHERE id = :id`,
          {
            type: QueryTypes.UPDATE,
            replacements: {
              id: row.id,
              reason: error instanceof Error ? error.message : String(error),
            },
          },
        );
      }
    }

    this.logger.log(`Selection run ${runId}: opened ${caseNumbers.length}, skipped ${skipped}`);
    return { opened: caseNumbers.length, skipped, caseNumbers };
  }

  async listRuns(): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT r.id, r.campaign_code, r.run_at, r.status,
              r.candidate_count, r.selected_count, r.criteria_json,
              count(c.id) FILTER (WHERE c.case_id IS NOT NULL)::int AS cases_opened
         FROM tax.tax_assessment_selection_run r
         LEFT JOIN tax.tax_selection_candidate c ON c.selection_run_id = r.id AND c.is_active
        WHERE r.is_active
        GROUP BY r.id
        ORDER BY r.run_at DESC`,
      { type: QueryTypes.SELECT },
    );
  }

  async candidatesFor(runId: number): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.total_score, c.matched_rules_json, c.selected, c.suppressed_reason,
              t.tin, t.name, k.case_number
         FROM tax.tax_selection_candidate c
         JOIN platform.taxpayer t ON t.id = c.taxpayer_id
         LEFT JOIN tax.tax_assessment_case k ON k.id = c.case_id
        WHERE c.selection_run_id = :runId AND c.is_active
        ORDER BY c.total_score DESC`,
      { type: QueryTypes.SELECT, replacements: { runId } },
    );
  }

  async rules(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT jurisdiction_code, tax_type_code, rule_code, display_key, indicator_code,
              parameters_json, weight, is_mandatory_referral
         FROM tax.tax_risk_rule
        WHERE is_active AND (:jurisdiction::text IS NULL OR jurisdiction_code = :jurisdiction)
        ORDER BY jurisdiction_code, weight DESC`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdiction ?? null } },
    );
  }

  // ------------------------------------------------------------------ indicators

  /**
   * Evaluate one rule against one taxpayer.
   *
   * Returns a human-readable reason when the rule fires, `undefined` when it
   * does not. The reason is stored, because "score 70" explains nothing to the
   * officer who has to work the case or to the taxpayer who asks why they were
   * picked.
   *
   * An unknown indicator throws rather than scoring zero: a rule that silently
   * never fires is worse than one that fails loudly, because nobody notices it
   * has stopped protecting anything.
   */
  private async evaluate(
    rule: { rule_code: string; indicator_code: string; parameters_json: Record<string, unknown> },
    taxpayer: { id: number },
    request: SelectionRequest,
  ): Promise<string | undefined> {
    switch (rule.indicator_code) {
      case 'NO_RETURN_FILED':
        return this.noReturnFiled(taxpayer.id, request);
      case 'LOSS_ABOVE':
        return this.lossAbove(taxpayer.id, rule.parameters_json, request);
      case 'CREDIT_RATIO_ABOVE':
        return this.creditRatioAbove(taxpayer.id, rule.parameters_json, request);
      case 'PRIOR_ADJUSTMENT_ABOVE':
        return this.priorAdjustmentAbove(taxpayer.id, rule.parameters_json, request);
      default:
        throw new BadRequestException(
          `Risk rule ${rule.rule_code} names indicator '${rule.indicator_code}', which this ` +
            'platform does not implement. Adding an indicator is a code change by design; ' +
            'thresholds and weights are not.',
        );
    }
  }

  private async noReturnFiled(
    taxpayerId: number,
    request: SelectionRequest,
  ): Promise<string | undefined> {
    const rows = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM forms.form_template_data d
         JOIN forms.form_template t ON t.id = d.form_template_id
        WHERE d.context_type = 'TAXPAYER' AND d.context_id = :taxpayerId
          AND d.status = 'SUBMITTED' AND d.is_active
          AND t.applies_to_year = :year
          AND t.template_code LIKE :prefix`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          taxpayerId,
          year: request.assessmentYear,
          prefix: `${request.taxTypeCode}-%`,
        },
      },
    );
    return Number(rows[0]?.count ?? 0) === 0
      ? `No ${request.taxTypeCode} return filed for ${request.assessmentYear}`
      : undefined;
  }

  private async lossAbove(
    taxpayerId: number,
    parameters: Record<string, unknown>,
    request: SelectionRequest,
  ): Promise<string | undefined> {
    const threshold = String(parameters['threshold'] ?? '0');
    const rows = await this.sequelize.query<{ total: string }>(
      `SELECT COALESCE(sum(original_amount - consumed_amount), 0)::text AS total
         FROM tax.taxpayer_loss
        WHERE taxpayer_id = :taxpayerId AND tax_type_code = :taxType AND is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { taxpayerId, taxType: request.taxTypeCode },
      },
    );
    const total = rows[0]?.total ?? '0';
    return Number(total) > Number(threshold)
      ? `Unused losses of ${total} exceed ${threshold}`
      : undefined;
  }

  private async creditRatioAbove(
    taxpayerId: number,
    parameters: Record<string, unknown>,
    request: SelectionRequest,
  ): Promise<string | undefined> {
    const rows = await this.sequelize.query<{ credits: string; payments: string }>(
      `SELECT COALESCE(sum(amount) FILTER (
                WHERE entry_type IN ('WITHHOLDING_CREDIT','FOREIGN_TAX_CREDIT')), 0)::text AS credits,
              COALESCE(sum(amount) FILTER (
                WHERE entry_type IN ('PAYMENT','ADVANCE_PAYMENT')), 0)::text AS payments
         FROM tax.taxpayer_account_entry
        WHERE taxpayer_id = :taxpayerId AND tax_type_code = :taxType
          AND assessment_year = :year AND is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { taxpayerId, taxType: request.taxTypeCode, year: request.assessmentYear },
      },
    );

    // Through Money, and without dividing.
    //
    // The first version of this parsed both figures with `Number()` and
    // compared `credits / total`, which the money lint rule refused -- rightly.
    // These are monetary amounts, and floating-point division of money is the
    // reflex ADR-007 exists to stop.
    //
    // `credits / total > ratio` is the same question as
    // `credits > total x ratio`, which `Money` answers exactly with a multiply
    // and a comparison. No division, no double, no rounding.
    const currency = await this.currencyFor(request);
    const credits = Money.of(rows[0]?.credits ?? '0', currency);
    const payments = Money.of(rows[0]?.payments ?? '0', currency);
    const total = credits.add(payments);

    // No money at all is not a high credit ratio, it is no data. Testing the
    // ratio here would score every dormant taxpayer as high risk.
    if (total.isZero()) return undefined;

    const threshold = total.multiply(Money.rate(String(parameters['ratio'] ?? '1')));
    return credits.greaterThan(threshold)
      ? `Credits of ${credits.toFixed(2)} against ${total.toFixed(2)} on the account`
      : undefined;
  }

  /**
   * The currency the jurisdiction assesses this tax in.
   *
   * Needed because the indicators compare amounts, and `Money` refuses to
   * compare two different currencies -- which is the behaviour that stops a
   * multi-jurisdiction register silently adding pounds to riyals.
   */
  private async currencyFor(request: SelectionRequest): Promise<string> {
    const rows = await this.sequelize.query<{ currency_code: string }>(
      `SELECT currency_code
         FROM tax.tax_rule_set
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND status = 'PUBLISHED'
          AND is_active
        ORDER BY effective_from DESC NULLS LAST
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: request.jurisdictionCode,
          taxType: request.taxTypeCode,
        },
      },
    );
    return rows[0]?.currency_code ?? 'GBP';
  }

  private async priorAdjustmentAbove(
    taxpayerId: number,
    parameters: Record<string, unknown>,
    request: SelectionRequest,
  ): Promise<string | undefined> {
    const threshold = String(parameters['threshold'] ?? '0');
    const rows = await this.sequelize.query<{ total: string; years: string }>(
      `SELECT COALESCE(sum(a.amount), 0)::text AS total,
              count(DISTINCT c.assessment_year)::text AS years
         FROM tax.tax_assessment_adjustment a
         JOIN tax.tax_assessment_case c ON c.id = a.case_id
        WHERE c.taxpayer_id = :taxpayerId
          AND c.tax_type_code = :taxType
          AND c.assessment_year < :year
          AND a.direction = 'ADD'
          AND a.is_active AND c.is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { taxpayerId, taxType: request.taxTypeCode, year: request.assessmentYear },
      },
    );
    const total = rows[0]?.total ?? '0';
    return Number(total) > Number(threshold)
      ? `Prior upward adjustments of ${total} across ${rows[0]?.years ?? '0'} year(s)`
      : undefined;
  }

  // ------------------------------------------------------------------ internals

  private async rulesFor(request: SelectionRequest): Promise<
    readonly {
      rule_code: string;
      indicator_code: string;
      parameters_json: Record<string, unknown>;
      weight: number;
      is_mandatory_referral: boolean;
    }[]
  > {
    return this.sequelize.query(
      `SELECT rule_code, indicator_code, parameters_json, weight, is_mandatory_referral
         FROM tax.tax_risk_rule
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND is_active
        ORDER BY weight DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: request.jurisdictionCode,
          taxType: request.taxTypeCode,
        },
      },
    );
  }

  private async taxpayersIn(
    request: SelectionRequest,
  ): Promise<readonly { id: number; tin: string; name: string }[]> {
    return this.sequelize.query(
      `SELECT id, tin, name
         FROM platform.taxpayer
        WHERE jurisdiction_code = :jurisdiction
          AND status = 'ACTIVE'
          AND is_active
        ORDER BY id`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: request.jurisdictionCode } },
    );
  }

  private async liveCaseFor(
    taxpayerId: number,
    request: SelectionRequest,
  ): Promise<string | undefined> {
    const rows = await this.sequelize.query<{ case_number: string }>(
      `SELECT case_number FROM tax.tax_assessment_case
        WHERE taxpayer_id = :taxpayerId
          AND tax_type_code = :taxType
          AND assessment_year = :year
          AND is_active
          AND status_code NOT IN ('CLOSED','CANCELLED','TIME_BARRED','WRITTEN_OFF')
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { taxpayerId, taxType: request.taxTypeCode, year: request.assessmentYear },
      },
    );
    return rows[0]?.case_number;
  }

  private async createRun(
    request: SelectionRequest,
    threshold: number,
    ruleCount: number,
    caller: RequestContext,
  ): Promise<number> {
    const rows = await this.sequelize.query<{ id: string }>(
      // The run table predates this service and has no jurisdiction columns of
      // its own, so the scope lives in `criteria_json` alongside the
      // thresholds. That keeps the whole basis of a run in one readable place,
      // which is what somebody auditing a selection actually wants.
      `INSERT INTO tax.tax_assessment_selection_run
              (campaign_code, criteria_json, run_at, run_by,
               candidate_count, selected_count, status,
               created_at, created_by, updated_at, is_active)
       VALUES (:campaign, :criteria, CURRENT_TIMESTAMP, :userId,
               0, 0, 'RUNNING',
               CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, true)
       RETURNING id::text AS id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          campaign: `${request.jurisdictionCode}-${request.taxTypeCode}-${request.assessmentYear}`,
          criteria: JSON.stringify({
            jurisdictionCode: request.jurisdictionCode,
            taxTypeCode: request.taxTypeCode,
            assessmentYear: request.assessmentYear,
            threshold,
            ruleCount,
            maxCases: request.maxCases ?? null,
          }),
          userId: caller.userId ?? null,
        },
      },
    );
    return Number(rows[0]!.id);
  }
}
