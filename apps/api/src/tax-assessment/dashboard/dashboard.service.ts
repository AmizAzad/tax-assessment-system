import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { registerScopeClause } from '../case/register-scope';

/**
 * The screen an officer opens first.
 *
 * Plan reference: V2 section 18.1 screen 2, section 21.3.
 *
 * ## Why the dashboard is scoped and the reports are not
 *
 * A report answers a question about the whole register — how much was
 * assessed, how much collected — and scoping it would make every total wrong.
 * A dashboard answers "what should I do today", which is a question about the
 * caller. So these queries carry the same scope predicate the register does,
 * from the same function, and an assessor's tiles count an assessor's cases.
 *
 * The practical consequence: a supervisor and an assessor looking at the same
 * screen see different numbers, and both are right.
 *
 * ## Why every figure comes back as text
 *
 * Money. The same rule as everywhere else (ADR-007): nothing between the
 * database and the screen turns an exact decimal into a double. Counts are
 * integers and are cast to `int`, so the client is never left guessing which
 * of the two a field is.
 *
 * ## Why there is no "total revenue" tile
 *
 * Assessed is not collected, and a tile that blurs them is the fastest way to
 * put a wrong number in a ministerial briefing. The summary reports them as
 * two figures, side by side, and never adds them together.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * The headline tiles.
   *
   * One round trip. Six separate queries would each re-derive the same scope
   * and the screen would show six independently-timed answers, which is how a
   * dashboard ends up contradicting itself between tiles.
   */
  async summary(caller: RequestContext): Promise<Record<string, unknown>> {
    const scope = registerScopeClause(caller.roleCodes);
    const replacements = { callerId: caller.userId ?? -1 };

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `WITH visible AS (
         SELECT c.* FROM tax.tax_assessment_case c
          WHERE c.is_active AND ${scope}
       )
       SELECT
         (SELECT count(*)::int FROM visible
           WHERE closed_at IS NULL)                                  AS open_cases,
         (SELECT count(*)::int FROM visible
           WHERE status_code IN ('INITIATED','DATA_READY','ASSIGNED','IN_PREPARATION',
                                 'AWAITING_TAXPAYER','CALCULATED',
                                 'REVIEW_RETURNED','REJECTED'))        AS in_preparation,
         (SELECT count(*)::int FROM visible
           WHERE status_code IN ('UNDER_REVIEW','REVIEWED'))          AS awaiting_review,
         (SELECT count(*)::int FROM visible
           WHERE status_code = 'PENDING_APPROVAL')                    AS awaiting_approval,
         (SELECT count(*)::int FROM visible
           WHERE status_code IN ('UNDER_OBJECTION','UNDER_APPEAL'))   AS in_dispute,
         (SELECT count(*)::int FROM visible
           WHERE finalised_at IS NOT NULL
             AND finalised_at >= date_trunc('month', CURRENT_DATE))   AS finalised_this_month,

         -- Assessed and collected, never summed together, and each one
         -- totalled per currency. A single sum across GBP and SAR is a number
         -- denominated in nothing (ADR-007), so the per-currency lists are the
         -- figures. The flat totals remain for a caller whose cases share one
         -- currency, and are NULL rather than wrong when they do not.
         (SELECT COALESCE(json_agg(json_build_object('currency', t.currency_code,
                                                     'amount', t.amount)
                                   ORDER BY t.currency_code), '[]'::json)
            FROM (SELECT r.currency_code, sum(r.net_payable_or_refundable)::text AS amount
                    FROM tax.tax_calculation_result r
                    JOIN visible v ON v.id = r.case_id
                   WHERE r.is_current
                   GROUP BY r.currency_code) t)                      AS net_assessed_by_currency,
         (SELECT COALESCE(json_agg(json_build_object('currency', t.currency_code,
                                                     'amount', t.amount)
                                   ORDER BY t.currency_code), '[]'::json)
            FROM (SELECT e.currency_code, sum(e.amount)::text AS amount
                    FROM tax.taxpayer_account_entry e
                   WHERE e.is_active
                     AND e.entry_type IN ('PAYMENT', 'ADVANCE_PAYMENT')
                     AND EXISTS (SELECT 1 FROM visible v
                                  WHERE v.taxpayer_id = e.taxpayer_id
                                    AND v.tax_type_code = e.tax_type_code
                                    AND v.assessment_year = e.assessment_year)
                   GROUP BY e.currency_code) t)                      AS collected_by_currency,
         (SELECT CASE WHEN count(DISTINCT r.currency_code) > 1 THEN NULL
                      ELSE COALESCE(sum(r.net_payable_or_refundable), 0)::text END
            FROM tax.tax_calculation_result r
            JOIN visible v ON v.id = r.case_id
           WHERE r.is_current)                                        AS net_assessed,
         (SELECT CASE WHEN count(DISTINCT e.currency_code) > 1 THEN NULL
                      ELSE COALESCE(sum(e.amount), 0)::text END
            FROM tax.taxpayer_account_entry e
           WHERE e.is_active
             AND e.entry_type IN ('PAYMENT', 'ADVANCE_PAYMENT')
             AND EXISTS (SELECT 1 FROM visible v
                          WHERE v.taxpayer_id = e.taxpayer_id
                            AND v.tax_type_code = e.tax_type_code
                            AND v.assessment_year = e.assessment_year)) AS collected,

         -- A statutory clock that has run out is the one number on this
         -- screen that is never merely informational.
         (SELECT count(*)::int
            FROM tax.tax_assessment_deadline d
            JOIN visible v ON v.id = d.case_id
           WHERE d.is_active AND d.status = 'OPEN'
             AND d.due_at < now())                                    AS overdue_deadlines,
         (SELECT count(*)::int
            FROM tax.tax_assessment_deadline d
            JOIN visible v ON v.id = d.case_id
           WHERE d.is_active AND d.status = 'OPEN'
             AND d.due_at >= now()
             AND d.due_at < (now() + interval '7 days'))              AS deadlines_this_week,

         -- Whatever the caller's cases are denominated in. Reported rather
         -- than assumed, so a mixed-jurisdiction officer sees that it is
         -- mixed instead of seeing two currencies added up.
         (SELECT string_agg(DISTINCT currency_code, ', ' ORDER BY currency_code)
            FROM visible)                                             AS currencies`,
      { type: QueryTypes.SELECT, replacements },
    );

    return rows[0] ?? {};
  }

  /**
   * Where the caller's work is sitting, and for how long.
   *
   * Two series: cases by status, and open cases by age band. The age bands
   * are the ones a supervisor asks about — a fortnight, a month, a quarter,
   * and "longer than that", which is the bucket that matters.
   */
  async workload(caller: RequestContext): Promise<Record<string, unknown>> {
    const scope = registerScopeClause(caller.roleCodes);
    const replacements = { callerId: caller.userId ?? -1 };

    const byStatus = await this.sequelize.query<Record<string, unknown>>(
      `SELECT c.status_code AS "statusCode", count(*)::int AS count
         FROM tax.tax_assessment_case c
        WHERE c.is_active AND ${scope} AND c.closed_at IS NULL
        GROUP BY c.status_code
        ORDER BY count(*) DESC`,
      { type: QueryTypes.SELECT, replacements },
    );

    const byAge = await this.sequelize.query<Record<string, unknown>>(
      `SELECT band AS "band", count(*)::int AS count
         FROM (
           SELECT CASE
                    WHEN CURRENT_DATE - c.opened_at::date <= 14  THEN '0-14 days'
                    WHEN CURRENT_DATE - c.opened_at::date <= 30  THEN '15-30 days'
                    WHEN CURRENT_DATE - c.opened_at::date <= 90  THEN '31-90 days'
                    ELSE 'over 90 days'
                  END AS band
             FROM tax.tax_assessment_case c
            WHERE c.is_active AND ${scope} AND c.closed_at IS NULL
         ) banded
        GROUP BY band
        ORDER BY CASE band
                   WHEN '0-14 days'   THEN 1
                   WHEN '15-30 days'  THEN 2
                   WHEN '31-90 days'  THEN 3
                   ELSE 4
                 END`,
      { type: QueryTypes.SELECT, replacements },
    );

    return { byStatus, byAge };
  }

  /**
   * Assessments finalised per month, with the value they carried.
   *
   * Twelve months, including the ones with nothing in them: a gap rendered as
   * a missing bar reads as "no data"; a zero reads as "no work finalised",
   * which is the fact.
   */
  async throughput(
    caller: RequestContext,
    months = 12,
  ): Promise<readonly Record<string, unknown>[]> {
    const scope = registerScopeClause(caller.roleCodes);

    return this.sequelize.query<Record<string, unknown>>(
      `WITH visible AS (
         SELECT c.* FROM tax.tax_assessment_case c
          WHERE c.is_active AND ${scope}
       ),
       calendar AS (
         SELECT generate_series(
                  date_trunc('month', CURRENT_DATE) - make_interval(months => :months - 1),
                  date_trunc('month', CURRENT_DATE),
                  interval '1 month') AS month_start
       )
       SELECT to_char(calendar.month_start, 'YYYY-MM') AS "month",
              count(v.id)::int AS "finalised",
              COALESCE(sum(r.net_payable_or_refundable), 0)::text AS "netAssessed"
         FROM calendar
         LEFT JOIN visible v
           ON v.finalised_at >= calendar.month_start
          AND v.finalised_at < calendar.month_start + interval '1 month'
         LEFT JOIN tax.tax_calculation_result r
           ON r.case_id = v.id AND r.is_current
        GROUP BY calendar.month_start
        ORDER BY calendar.month_start`,
      { type: QueryTypes.SELECT, replacements: { callerId: caller.userId ?? -1, months } },
    );
  }

  /**
   * Internal service levels and statutory deadlines, side by side.
   *
   * They are different things and the screen says so. An SLA is a promise the
   * authority made to itself; a statutory deadline is one the law made for
   * it. Missing the first is a management problem. Missing the second can
   * make an assessment unenforceable, which is why the two are never merged
   * into one "at risk" number.
   */
  async sla(caller: RequestContext): Promise<Record<string, unknown>> {
    const scope = registerScopeClause(caller.roleCodes);
    const replacements = { callerId: caller.userId ?? -1 };

    const service = await this.sequelize.query<Record<string, unknown>>(
      `SELECT t.sla_code AS "slaCode",
              count(*) FILTER (WHERE t.status = 'RUNNING' AND t.target_at >= now())::int AS "onTrack",
              count(*) FILTER (WHERE t.status = 'RUNNING' AND t.target_at < now())::int  AS "overdue",
              count(*) FILTER (WHERE t.status = 'BREACHED')::int                         AS "breached",
              count(*) FILTER (WHERE t.status = 'COMPLETED')::int                        AS "completed"
         FROM tax.tax_sla_tracker t
         JOIN tax.tax_assessment_case c ON c.id = t.case_id
        WHERE t.is_active AND c.is_active AND ${scope}
        GROUP BY t.sla_code
        ORDER BY t.sla_code`,
      { type: QueryTypes.SELECT, replacements },
    );

    const statutory = await this.sequelize.query<Record<string, unknown>>(
      `SELECT d.deadline_type AS "deadlineType",
              c.case_number   AS "caseNumber",
              c.id            AS "caseId",
              d.due_at        AS "dueAt",
              (d.due_at::date - CURRENT_DATE)::int AS "daysRemaining"
         FROM tax.tax_assessment_deadline d
         JOIN tax.tax_assessment_case c ON c.id = d.case_id
        WHERE d.is_active AND c.is_active AND ${scope}
          AND d.status = 'OPEN'
          AND d.due_at <= (now() + interval '14 days')
        ORDER BY d.due_at
        LIMIT 50`,
      { type: QueryTypes.SELECT, replacements },
    );

    return { service, statutory };
  }
}
