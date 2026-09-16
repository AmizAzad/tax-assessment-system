import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';

export interface ReportFilters {
  readonly jurisdiction?: string;
  readonly taxType?: string;
  readonly assessmentYear?: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * Management reporting.
 *
 * Plan reference: V2 sections 21.1 to 21.4 (Phase 8).
 *
 * ## Why amounts come back as strings
 *
 * Every monetary figure is `::text`. A report that summed in JavaScript
 * numbers would disagree with the assessments it reports on, and a management
 * pack that does not tie back to the register is worse than no pack at all
 * (ADR-007).
 *
 * ## Why these are read-only and unscoped by assignment
 *
 * Reports answer questions about the whole register: how much was assessed,
 * how much collected, where cases are stuck. Scoping them to the caller's own
 * cases would make every total wrong. Access is therefore controlled at the
 * route, and the permission is granted to oversight roles rather than to
 * caseworkers.
 */
@Injectable()
export class ReportingService {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Cases and money by status. The first screen a head of assessment opens. */
  async assessmentSummary(filters: ReportFilters): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.jurisdiction_code, c.tax_type_code, c.assessment_year, c.status_code,
              count(*)::int AS case_count,
              COALESCE(sum(r.net_payable_or_refundable), 0)::text AS net_assessed,
              max(r.currency_code) AS currency_code
         FROM tax.tax_assessment_case c
         LEFT JOIN tax.tax_calculation_result r ON r.case_id = c.id AND r.is_current
        WHERE c.is_active
          ${this.scopeClause()}
        GROUP BY c.jurisdiction_code, c.tax_type_code, c.assessment_year, c.status_code
        ORDER BY c.jurisdiction_code, c.tax_type_code, c.assessment_year, c.status_code`,
      { type: QueryTypes.SELECT, replacements: this.scopeValues(filters) },
    );
  }

  /**
   * Assessed against collected.
   *
   * The single number a finance ministry asks for. Kept honest by reading
   * payments from the account rather than inferring collection from case
   * status: a closed case is not necessarily a paid one.
   */
  async collection(filters: ReportFilters): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.jurisdiction_code, c.tax_type_code, c.assessment_year,
              count(DISTINCT c.id)::int AS case_count,
              COALESCE(sum(r.net_payable_or_refundable), 0)::text AS net_assessed,
              COALESCE((
                SELECT sum(e.amount)
                  FROM tax.taxpayer_account_entry e
                  JOIN platform.taxpayer t ON t.id = e.taxpayer_id
                 WHERE e.tax_type_code = c.tax_type_code
                   AND e.assessment_year = c.assessment_year
                   -- Scoped to the jurisdiction being reported. Without this
                   -- the subquery sums every jurisdiction's payments into each
                   -- row, so a second jurisdiction appears to have collected
                   -- the first one's money.
                   AND t.jurisdiction_code = c.jurisdiction_code
                   AND e.entry_type IN ('PAYMENT', 'ADVANCE_PAYMENT')
                   AND e.is_active
              ), 0)::text AS collected,
              max(r.currency_code) AS currency_code
         FROM tax.tax_assessment_case c
         LEFT JOIN tax.tax_calculation_result r ON r.case_id = c.id AND r.is_current
        WHERE c.is_active
          ${this.scopeClause()}
        GROUP BY c.jurisdiction_code, c.tax_type_code, c.assessment_year
        ORDER BY c.jurisdiction_code, c.tax_type_code, c.assessment_year`,
      { type: QueryTypes.SELECT, replacements: this.scopeValues(filters) },
    );
  }

  /**
   * Why assessments move.
   *
   * Adjustment reasons ranked by value. This is the report that tells an
   * authority which risk rules are earning their keep and which are noise.
   */
  async adjustmentAnalysis(filters: ReportFilters): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.jurisdiction_code, c.tax_type_code,
              a.adjustment_type, a.reason_code,
              count(*)::int AS occurrences,
              sum(CASE WHEN a.direction = 'ADD' THEN a.amount ELSE -a.amount END)::text AS net_effect,
              avg(a.amount)::numeric(20,4)::text AS average_amount
         FROM tax.tax_assessment_adjustment a
         JOIN tax.tax_assessment_case c ON c.id = a.case_id
        WHERE a.is_active AND c.is_active
          ${this.scopeClause()}
        GROUP BY c.jurisdiction_code, c.tax_type_code, a.adjustment_type, a.reason_code
        ORDER BY sum(CASE WHEN a.direction = 'ADD' THEN a.amount ELSE -a.amount END) DESC`,
      { type: QueryTypes.SELECT, replacements: this.scopeValues(filters) },
    );
  }

  /**
   * How often the authority is wrong.
   *
   * An objection and appeal success rate. Uncomfortable to publish and the
   * most useful number here: a jurisdiction losing most of its objections has
   * an assessment quality problem, not a dispute problem.
   */
  async disputeOutcomes(filters: ReportFilters): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT 'OBJECTION' AS stage, c.jurisdiction_code,
              count(*) FILTER (WHERE o.decision = 'ALLOWED')::int AS allowed,
              count(*) FILTER (WHERE o.decision = 'PARTLY_ALLOWED')::int AS partly_allowed,
              count(*) FILTER (WHERE o.decision = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE o.decision IS NULL)::int AS undecided,
              count(*) FILTER (WHERE NOT o.was_in_time)::int AS out_of_time
         FROM tax.tax_objection o
         JOIN tax.tax_assessment_case c ON c.id = o.case_id
        WHERE o.is_active ${this.scopeClause()}
        GROUP BY c.jurisdiction_code
       UNION ALL
       SELECT 'APPEAL', c.jurisdiction_code,
              count(*) FILTER (WHERE a.outcome IN ('SET_ASIDE'))::int,
              count(*) FILTER (WHERE a.outcome IN ('VARIED', 'REMANDED'))::int,
              count(*) FILTER (WHERE a.outcome = 'UPHELD')::int,
              count(*) FILTER (WHERE a.outcome IS NULL)::int,
              count(*) FILTER (WHERE NOT a.was_in_time)::int
         FROM tax.tax_appeal a
         JOIN tax.tax_assessment_case c ON c.id = a.case_id
        WHERE a.is_active ${this.scopeClause()}
        GROUP BY c.jurisdiction_code`,
      { type: QueryTypes.SELECT, replacements: this.scopeValues(filters) },
    );
  }

  /**
   * Where cases are stuck, and for how long.
   *
   * Ageing by status. The report that finds the case nobody has touched for
   * eight months, which is usually the one that becomes a complaint.
   */
  async ageing(filters: ReportFilters): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.jurisdiction_code, c.status_code,
              count(*)::int AS case_count,
              round(avg(EXTRACT(EPOCH FROM (now() - c.updated_at)) / 86400))::int AS avg_days_in_status,
              max(round(EXTRACT(EPOCH FROM (now() - c.updated_at)) / 86400))::int AS oldest_days,
              count(*) FILTER (
                WHERE c.updated_at < now() - INTERVAL '90 days'
              )::int AS over_90_days
         FROM tax.tax_assessment_case c
        WHERE c.is_active
          AND c.status_code NOT IN ('CLOSED', 'CANCELLED', 'SETTLED', 'WRITTEN_OFF')
          ${this.scopeClause()}
        GROUP BY c.jurisdiction_code, c.status_code
        ORDER BY over_90_days DESC, case_count DESC`,
      { type: QueryTypes.SELECT, replacements: this.scopeValues(filters) },
    );
  }

  /** Statutory clocks that have run out, and ones about to. */
  async deadlineExposure(): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.jurisdiction_code, d.deadline_type, d.status,
              count(*)::int AS deadline_count,
              count(*) FILTER (WHERE d.due_at < CURRENT_DATE AND d.status = 'OPEN')::int AS overdue,
              count(*) FILTER (
                WHERE d.due_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'
                  AND d.status = 'OPEN'
              )::int AS due_within_14_days
         FROM tax.tax_assessment_deadline d
         JOIN tax.tax_assessment_case c ON c.id = d.case_id
        WHERE d.is_active
        GROUP BY c.jurisdiction_code, d.deadline_type, d.status
        ORDER BY overdue DESC, due_within_14_days DESC`,
      { type: QueryTypes.SELECT },
    );
  }

  /**
   * Notices issued but never successfully served.
   *
   * A notice that was never served does not start any clock, so these cases
   * are silently frozen. Nothing else in the system surfaces them.
   */
  async unservedNotices(): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.case_number, c.tin, n.notice_number, n.notice_type,
              n.issued_at, n.status,
              count(s.id)::int AS attempts,
              count(s.id) FILTER (WHERE s.status IN ('FAILED', 'RETURNED'))::int AS failures
         FROM tax.tax_assessment_notice n
         JOIN tax.tax_assessment_case c ON c.id = n.case_id
         LEFT JOIN tax.tax_notice_service s ON s.notice_id = n.id AND s.is_active
        WHERE n.is_active AND n.status = 'ISSUED'
        GROUP BY c.case_number, c.tin, n.notice_number, n.notice_type, n.issued_at, n.status
        ORDER BY n.issued_at`,
      { type: QueryTypes.SELECT },
    );
  }

  /**
   * Reconciliation: places where the register contradicts itself.
   *
   * Every row returned is a defect, not a metric. Run it as a scheduled check;
   * an empty result is the expected answer, and anything else needs a person.
   */
  async reconciliation(): Promise<Record<string, readonly Record<string, unknown>[]>> {
    const [orphanCalculations, unconsumedLosses, settledWithBalance, finalisedWithoutNotice] =
      await Promise.all([
        // A case with figures but no current calculation row.
        this.sequelize.query<Record<string, unknown>>(
          `SELECT c.case_number, c.status_code
             FROM tax.tax_assessment_case c
            WHERE c.is_active
              AND c.status_code IN ('FINALISED','NOTICE_GENERATED','NOTICE_SERVED','SETTLED','CLOSED')
              AND NOT EXISTS (
                SELECT 1 FROM tax.tax_calculation_result r
                 WHERE r.case_id = c.id AND r.is_current)`,
          { type: QueryTypes.SELECT },
        ),

        // Loss consumption that does not match the utilisation rows behind it.
        this.sequelize.query<Record<string, unknown>>(
          `SELECT l.id, l.origin_year,
                  l.consumed_amount::text AS consumed_amount,
                  COALESCE(sum(u.amount_used), 0)::text AS utilisations_total
             FROM tax.taxpayer_loss l
             LEFT JOIN tax.tax_loss_utilisation u ON u.loss_id = l.id AND u.is_active
            WHERE l.is_active
            GROUP BY l.id, l.origin_year, l.consumed_amount
           HAVING l.consumed_amount <> COALESCE(sum(u.amount_used), 0)`,
          { type: QueryTypes.SELECT },
        ),

        // Cases marked settled that still show money outstanding.
        this.sequelize.query<Record<string, unknown>>(
          `SELECT c.case_number, x.final_balance::text AS final_balance
             FROM tax.tax_assessment_case c
             JOIN tax.tax_case_closure x ON x.case_id = c.id AND x.is_active
            WHERE x.reason_code = 'SETTLED_IN_FULL'
              AND x.final_balance > 0`,
          { type: QueryTypes.SELECT },
        ),

        // Finalised long ago with no notice ever issued: the determination
        // exists but the taxpayer was never told.
        this.sequelize.query<Record<string, unknown>>(
          `SELECT c.case_number, c.finalised_at
             FROM tax.tax_assessment_case c
            WHERE c.is_active
              AND c.finalised_at IS NOT NULL
              AND c.finalised_at < now() - INTERVAL '7 days'
              AND NOT EXISTS (
                SELECT 1 FROM tax.tax_assessment_notice n
                 WHERE n.case_id = c.id AND n.is_active)`,
          { type: QueryTypes.SELECT },
        ),
      ]);

    return {
      orphanCalculations,
      unconsumedLosses,
      settledWithBalance,
      finalisedWithoutNotice,
    };
  }

  // ------------------------------------------------------------------ internals

  /**
   * The shared filter clause.
   *
   * `::text IS NULL` on each parameter so one prepared shape serves every
   * combination, rather than building SQL by string concatenation from user
   * input.
   */
  private scopeClause(): string {
    return `AND (:jurisdiction::text IS NULL OR c.jurisdiction_code = :jurisdiction)
            AND (:taxType::text IS NULL OR c.tax_type_code = :taxType)
            AND (:assessmentYear::text IS NULL OR c.assessment_year = :assessmentYear)
            AND (:from::date IS NULL OR c.opened_at >= :from::date)
            AND (:to::date IS NULL OR c.opened_at < (:to::date + 1))`;
  }

  private scopeValues(filters: ReportFilters): Record<string, string | null> {
    return {
      jurisdiction: filters.jurisdiction ?? null,
      taxType: filters.taxType ?? null,
      assessmentYear: filters.assessmentYear ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null,
    };
  }
}
