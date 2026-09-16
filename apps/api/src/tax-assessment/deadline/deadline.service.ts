import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import {
  DAY_CODES,
  addBusinessDays,
  addDays,
  addMonths,
  daysBetween,
  emptyCalendar,
  endOfMonth,
  formatDate,
  parseDate,
  rollForwardToBusinessDay,
  today,
  type BusinessCalendar,
  type DayCode,
} from './business-calendar';

export type DeadlineType =
  'FILING' | 'PAYMENT' | 'OBJECTION' | 'RESPONSE' | 'APPEAL' | 'LIMITATION';

export interface DeadlineConfig {
  readonly deadlineType: string;
  readonly anchorEvent: string;
  readonly offsetValue: number;
  readonly offsetUnit: 'DAYS' | 'MONTHS' | 'YEARS';
  readonly calendarRule: 'CALENDAR_DAYS' | 'BUSINESS_DAYS' | 'MONTH_END' | 'NEXT_BUSINESS_DAY';
  /**
   * A second offset applied after the first.
   *
   * Exists because real deadlines are not always a single unit. The UK
   * corporation tax payment date is nine months and one day after the period
   * end, and rounding that to nine months would charge every taxpayer an
   * extra day of interest.
   */
  readonly secondaryOffsetValue: number | null;
  readonly secondaryOffsetUnit: 'DAYS' | 'MONTHS' | 'YEARS' | null;
}

export interface ResolvedDeadline {
  readonly deadlineType: string;
  readonly anchorEvent: string;
  readonly anchorDate: string;
  readonly dueDate: string;
  /** Plain-language derivation, for the deadline panel and the case file. */
  readonly derivation: string;
}

export interface Lateness {
  readonly filingDaysLate: number;
  readonly daysLate: number;
  readonly filingDueDate?: string;
  readonly paymentDueDate?: string;
}

/**
 * Statutory dates.
 *
 * Plan reference: V2 sections 10.1 to 10.4.
 *
 * ## Why this is server-side and configuration-driven
 *
 * A filing deadline decides whether a penalty arises. It is a legal figure, so
 * by the governing rule it cannot be computed in a browser, and it cannot be
 * hard-coded either: the offsets differ per jurisdiction, per tax type, and
 * change between years. `tax.tax_deadline_config` holds anchor, offset and
 * calendar rule; this service applies them.
 *
 * ## Dates are handled as plain dates, never as instants
 *
 * Every date here is a `YYYY-MM-DD` string manipulated through UTC. A
 * statutory deadline is a calendar date in the jurisdiction, not a moment, and
 * putting it through a local-time `Date` would move it by a day for anyone
 * west of Greenwich. That is a real defect class in tax software: a return
 * filed on the due date showing as one day late because the server was in a
 * different timezone than the taxpayer.
 *
 * ## The business-day calendar
 *
 * `BUSINESS_DAYS` and `NEXT_BUSINESS_DAY` read `platform.holiday` and the
 * jurisdiction's `WEEKEND_DAYS` master data. The weekend is configuration
 * because it is not Saturday and Sunday everywhere; a platform that assumes
 * the western weekend cannot be configured for a Sunday-to-Thursday working
 * week, which is the promise this system makes about adding a jurisdiction.
 *
 * Calendars are cached per jurisdiction for a few minutes. A holiday added
 * today applies to deadlines computed after the cache turns over, which is
 * acceptable because holidays are legislated well in advance; nothing here
 * depends on a holiday appearing the instant it is inserted.
 */
@Injectable()
export class DeadlineService {
  private readonly logger = new Logger(DeadlineService.name);

  /** Per-jurisdiction working calendars, with a short time to live. */
  private readonly calendarCache = new Map<
    string,
    { calendar: BusinessCalendar; loadedAt: number }
  >();

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * How late the return and the payment were.
   *
   * Returns zeros where nothing is late, and where no deadline is configured.
   * A missing configuration must not invent a penalty: the absence of a rule
   * is not the presence of a breach.
   */
  async lateness(
    assessmentCase: {
      readonly id: number;
      readonly jurisdictionCode: string;
      readonly taxTypeCode: string;
      readonly assessmentYear: string;
    },
    filedOn: string | undefined,
    dueOn: string | undefined,
  ): Promise<Lateness> {
    const periodEnd = await this.periodEndFor(assessmentCase);

    const filingDue =
      periodEnd === undefined ? undefined : await this.resolve(assessmentCase, 'FILING', periodEnd);
    const paymentDue =
      dueOn ??
      (periodEnd === undefined
        ? undefined
        : (await this.resolve(assessmentCase, 'PAYMENT', periodEnd))?.dueDate);

    // A return that was never filed is not "zero days late": it has no filing
    // date to measure from. Lateness is counted to today, which is what makes
    // a non-filer's penalty grow until they file.
    const filingMeasuredAt = filedOn ?? today();

    return {
      filingDaysLate:
        filingDue === undefined ? 0 : daysBetween(filingDue.dueDate, filingMeasuredAt),
      daysLate: paymentDue === undefined ? 0 : daysBetween(paymentDue, today()),
      filingDueDate: filingDue?.dueDate,
      paymentDueDate: paymentDue,
    };
  }

  /**
   * Apply one configured deadline to an anchor date.
   *
   * Returns undefined when no configuration is in force, which the callers
   * treat as "no deadline of this kind applies" rather than as an error.
   */
  async resolve(
    scope: { readonly jurisdictionCode: string; readonly taxTypeCode: string },
    deadlineType: DeadlineType | string,
    anchorDate: string,
  ): Promise<ResolvedDeadline | undefined> {
    const rows = await this.sequelize.query<DeadlineConfig>(
      `SELECT deadline_type AS "deadlineType",
              anchor_event   AS "anchorEvent",
              offset_value   AS "offsetValue",
              offset_unit    AS "offsetUnit",
              calendar_rule  AS "calendarRule",
              secondary_offset_value AS "secondaryOffsetValue",
              secondary_offset_unit  AS "secondaryOffsetUnit"
         FROM tax.tax_deadline_config
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND deadline_type = :deadlineType
          AND is_active
          AND (effective_from IS NULL OR effective_from <= :anchorDate)
          AND (effective_to IS NULL OR effective_to > :anchorDate)
        ORDER BY effective_from DESC NULLS LAST
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: scope.jurisdictionCode,
          taxType: scope.taxTypeCode,
          deadlineType,
          anchorDate,
        },
      },
    );

    const config = rows[0];
    if (config === undefined) return undefined;

    // Only fetched when a rule actually needs it, so a calendar-days deadline
    // costs no extra query.
    const calendar = needsCalendar(config.calendarRule)
      ? await this.calendarFor(scope.jurisdictionCode)
      : emptyCalendar();

    const { dueDate, note } = this.applyOffset(anchorDate, config, calendar);

    const secondary =
      config.secondaryOffsetValue !== null && config.secondaryOffsetUnit !== null
        ? ` and ${plural(config.secondaryOffsetValue, config.secondaryOffsetUnit)}`
        : '';

    return {
      deadlineType: config.deadlineType,
      anchorEvent: config.anchorEvent,
      anchorDate,
      dueDate,
      derivation:
        `${config.anchorEvent} ${anchorDate} plus ${plural(config.offsetValue, config.offsetUnit)}` +
        `${secondary} (${config.calendarRule})${note}`,
    };
  }

  /**
   * Apply an ad-hoc offset using a jurisdiction's working calendar.
   *
   * For rules that are not deadline configuration but still have to respect
   * the same holidays: deemed service is the case that drives this. Keeping it
   * here rather than letting the service layer do its own date arithmetic is
   * what stops two different notions of "two working days" existing.
   */
  async applyOffsetFor(
    jurisdictionCode: string,
    anchorDate: string,
    offset: {
      offsetValue: number;
      offsetUnit: 'DAYS' | 'MONTHS' | 'YEARS';
      calendarRule: 'CALENDAR_DAYS' | 'BUSINESS_DAYS' | 'MONTH_END' | 'NEXT_BUSINESS_DAY';
    },
  ): Promise<string> {
    const calendar = needsCalendar(offset.calendarRule)
      ? await this.calendarFor(jurisdictionCode)
      : emptyCalendar();

    const { dueDate } = this.applyOffset(
      anchorDate,
      {
        deadlineType: 'AD_HOC',
        anchorEvent: 'AD_HOC',
        offsetValue: offset.offsetValue,
        offsetUnit: offset.offsetUnit,
        calendarRule: offset.calendarRule,
        secondaryOffsetValue: null,
        secondaryOffsetUnit: null,
      },
      calendar,
    );
    return dueDate;
  }

  /**
   * Write the deadlines triggered by an event onto the case.
   *
   * Until this runs, a deadline is a calculation nobody is watching.
   * Materialising it gives the scheduler a row to sweep and the case file a
   * date a caseworker can see.
   *
   * Idempotent per case, type and anchor: serving the same notice through a
   * second channel must not create a second objection window.
   *
   * An **open** deadline is re-anchored if the anchor date has moved. That is
   * not a nicety. Deemed service can shift after the fact -- a letter proved
   * delivered earlier than the statutory assumption, or a returned letter
   * replaced by an email -- and the objection window runs from deemed service.
   * Leaving the original date would tell the taxpayer and the officer that
   * the window closes on a day the law does not support, in either direction.
   *
   * A deadline already breached or satisfied is left alone: re-opening a
   * closed window is a decision for a person, not a side effect of recording
   * a delivery receipt.
   */
  async materialise(
    assessmentCase: {
      readonly id: number;
      readonly jurisdictionCode: string;
      readonly taxTypeCode: string;
    },
    anchorEvent: string,
    anchorDate: string,
    caller: RequestContext,
  ): Promise<readonly ResolvedDeadline[]> {
    const configs = await this.sequelize.query<{ id: number; deadline_type: string }>(
      `SELECT id, deadline_type
         FROM tax.tax_deadline_config
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND anchor_event = :anchorEvent
          AND is_active
        ORDER BY deadline_type`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: assessmentCase.jurisdictionCode,
          taxType: assessmentCase.taxTypeCode,
          anchorEvent,
        },
      },
    );

    const written: ResolvedDeadline[] = [];

    for (const config of configs) {
      const resolved = await this.resolve(assessmentCase, config.deadline_type, anchorDate);
      if (resolved === undefined) continue;

      const replacements = {
        caseId: assessmentCase.id,
        deadlineType: config.deadline_type,
        anchorEvent,
        anchorAt: anchorDate,
        dueAt: resolved.dueDate,
        configId: config.id,
        userId: caller.userId ?? null,
      };

      const moved = await this.sequelize.query<{ due_at: string }>(
        `UPDATE tax.tax_assessment_deadline
            SET anchor_at = :anchorAt::date,
                due_at = :dueAt::date,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = :userId
          WHERE case_id = :caseId
            AND deadline_type = :deadlineType
            AND anchor_event = :anchorEvent
            AND status = 'OPEN'
            AND is_active
            AND (anchor_at <> :anchorAt::date OR due_at <> :dueAt::date)
        RETURNING due_at::text AS due_at`,
        { type: QueryTypes.SELECT, replacements },
      );

      if (moved.length > 0) {
        // Worth a log line: a moving statutory date is exactly the thing an
        // officer will later be asked to explain.
        this.logger.log(
          `Case ${assessmentCase.id}: ${config.deadline_type} re-anchored to ${anchorDate}, ` +
            `now due ${resolved.dueDate}`,
        );
      } else {
        await this.sequelize.query(
          `INSERT INTO tax.tax_assessment_deadline
                  (case_id, deadline_type, anchor_event, anchor_at, due_at, status, config_id,
                   created_at, created_by, updated_at, updated_by, is_active)
           SELECT :caseId, :deadlineType, :anchorEvent, :anchorAt::date, :dueAt::date, 'OPEN', :configId,
                  CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true
            WHERE NOT EXISTS (
              SELECT 1 FROM tax.tax_assessment_deadline
               WHERE case_id = :caseId AND deadline_type = :deadlineType
                 AND anchor_event = :anchorEvent AND is_active)`,
          { type: QueryTypes.INSERT, replacements },
        );
      }

      written.push(resolved);
    }

    if (written.length > 0) {
      this.logger.log(
        `Case ${assessmentCase.id}: materialised ${written.map((d) => d.deadlineType).join(', ')} ` +
          `from ${anchorEvent} ${anchorDate}`,
      );
    }
    return written;
  }

  /** The deadlines actually recorded against a case, with their state. */
  async recordedFor(caseId: number): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT deadline_type, anchor_event, anchor_at::text AS anchor_at,
              due_at::text AS due_at, status, warned_at, breached_at
         FROM tax.tax_assessment_deadline
        WHERE case_id = :caseId AND is_active
        ORDER BY due_at`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
  }

  /** Close an open deadline because the thing it was waiting for happened. */
  async satisfy(caseId: number, deadlineType: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE tax.tax_assessment_deadline
          SET status = 'SATISFIED', updated_at = CURRENT_TIMESTAMP
        WHERE case_id = :caseId AND deadline_type = :deadlineType
          AND status = 'OPEN' AND is_active`,
      { type: QueryTypes.UPDATE, replacements: { caseId, deadlineType } },
    );
  }

  /** Every deadline configured for a case, for the deadline panel. */
  async allFor(assessmentCase: {
    readonly id: number;
    readonly jurisdictionCode: string;
    readonly taxTypeCode: string;
    readonly assessmentYear: string;
  }): Promise<readonly ResolvedDeadline[]> {
    const periodEnd = await this.periodEndFor(assessmentCase);
    if (periodEnd === undefined) return [];

    const types = await this.sequelize.query<{ deadline_type: string }>(
      `SELECT DISTINCT deadline_type
         FROM tax.tax_deadline_config
        WHERE jurisdiction_code = :jurisdiction AND tax_type_code = :taxType AND is_active
        ORDER BY deadline_type`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: assessmentCase.jurisdictionCode,
          taxType: assessmentCase.taxTypeCode,
        },
      },
    );

    const resolved: ResolvedDeadline[] = [];
    for (const row of types) {
      // Only period-anchored deadlines can be resolved without an event date.
      // An objection deadline anchored on NOTICE_SERVED has no due date until
      // the notice is actually served, and showing one computed from the
      // period end would be a fabricated date on a legal document.
      const deadline = await this.resolve(assessmentCase, row.deadline_type, periodEnd);
      if (deadline !== undefined && isPeriodAnchored(deadline.anchorEvent)) {
        resolved.push(deadline);
      }
    }
    return resolved;
  }

  /**
   * The period end this case is assessed on.
   *
   * Prefers the recorded period, because an accounting period is a fact about
   * the taxpayer and need not align with a calendar year. Falls back to the
   * last day of the assessment year, which is right for jurisdictions with a
   * fixed fiscal year and wrong for a company with a non-standard year end,
   * so the fallback is logged.
   */
  private async periodEndFor(assessmentCase: {
    readonly id: number;
    readonly assessmentYear: string;
  }): Promise<string | undefined> {
    const rows = await this.sequelize.query<{ period_end: string }>(
      `SELECT period_end::text AS period_end
         FROM tax.tax_assessment_period
        WHERE case_id = :caseId AND is_active
        ORDER BY period_end DESC
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { caseId: assessmentCase.id } },
    );

    const recorded = rows[0]?.period_end;
    if (recorded !== undefined) return recorded;

    const year = /^(\d{4})/.exec(assessmentCase.assessmentYear)?.[1];
    if (year === undefined) return undefined;

    this.logger.debug(
      `Case ${assessmentCase.id} has no recorded period; assuming ${year}-12-31. ` +
        'Record the accounting period for a non-calendar year end.',
    );
    return `${year}-12-31`;
  }

  /** Offset arithmetic in UTC, with the calendar rule applied. */
  private applyOffset(
    anchorDate: string,
    config: DeadlineConfig,
    calendar: BusinessCalendar,
  ): { dueDate: string; note: string } {
    const anchor = parseDate(anchorDate);
    const businessDays = config.calendarRule === 'BUSINESS_DAYS';

    let due = shift(anchor, config.offsetValue, config.offsetUnit, businessDays, calendar);

    // Applied after the first, not combined with it. Nine months then one day
    // and one day then nine months can differ when the month-end clamp bites,
    // and the statute states the months first.
    if (config.secondaryOffsetValue !== null && config.secondaryOffsetUnit !== null) {
      due = shift(
        due,
        config.secondaryOffsetValue,
        config.secondaryOffsetUnit,
        businessDays,
        calendar,
      );
    }

    if (config.calendarRule === 'MONTH_END') {
      due = endOfMonth(due);
    }

    let note = '';
    if (config.calendarRule === 'NEXT_BUSINESS_DAY') {
      const rolled = rollForwardToBusinessDay(due, calendar);
      if (rolled.getTime() !== due.getTime()) {
        // Forward, never back: moving a deadline earlier than the statute
        // allows shortens the taxpayer's time, which is the harmful error.
        note = `, rolled forward from ${formatDate(due)} to the next working day`;
        due = rolled;
      }
    }

    return { dueDate: formatDate(due), note };
  }

  /**
   * The working calendar for a jurisdiction.
   *
   * Cached briefly. Holidays are legislated in advance, so nothing depends on
   * one appearing the instant it is inserted, and a per-deadline query would
   * make the register screen issue one round trip per row.
   */
  private async calendarFor(jurisdictionCode: string): Promise<BusinessCalendar> {
    const cached = this.calendarCache.get(jurisdictionCode);
    if (cached !== undefined && Date.now() - cached.loadedAt < CALENDAR_TTL_MS) {
      return cached.calendar;
    }

    const [holidayRows, weekendRows] = await Promise.all([
      this.sequelize.query<{ holiday_date: string }>(
        `SELECT holiday_date::text AS holiday_date
           FROM platform.holiday
          WHERE jurisdiction_code = :jurisdiction AND is_active`,
        { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode } },
      ),
      this.sequelize.query<{ item_code: string }>(
        `SELECT i.item_code
           FROM platform.master_data_item i
           JOIN platform.master_data d ON d.id = i.master_data_id
          WHERE d.group_code = 'WEEKEND_DAYS'
            AND d.jurisdiction_code = :jurisdiction
            AND d.is_active AND i.is_active`,
        { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode } },
      ),
    ]);

    const configured = weekendRows
      .map((row) => row.item_code.toUpperCase())
      .filter((code): code is DayCode => (DAY_CODES as readonly string[]).includes(code));

    if (weekendRows.length > 0 && configured.length === 0) {
      // Configured but unusable is worse than unconfigured, because it looks
      // deliberate. Say so rather than silently falling back.
      this.logger.warn(
        `WEEKEND_DAYS for ${jurisdictionCode} contains no recognised day codes ` +
          `(expected any of ${DAY_CODES.join(', ')}). Using the default weekend.`,
      );
    }

    const calendar: BusinessCalendar = {
      weekendDays: configured.length > 0 ? new Set(configured) : emptyCalendar().weekendDays,
      holidays: new Set(holidayRows.map((row) => row.holiday_date)),
    };

    this.calendarCache.set(jurisdictionCode, { calendar, loadedAt: Date.now() });
    return calendar;
  }

  /** Drops the cached calendars. Called when a holiday is added. */
  clearCalendarCache(): void {
    this.calendarCache.clear();
  }
}

const CALENDAR_TTL_MS = 5 * 60 * 1000;

function needsCalendar(rule: string): boolean {
  return rule === 'BUSINESS_DAYS' || rule === 'NEXT_BUSINESS_DAY';
}

/**
 * Whether a deadline can be computed from the period alone.
 *
 * The alternative would be to resolve every deadline from the period end,
 * which produces plausible-looking dates for events that have not happened.
 */
function isPeriodAnchored(anchorEvent: string): boolean {
  return anchorEvent === 'PERIOD_END' || anchorEvent === 'PERIOD_START';
}

/**
 * "9 months and 1 day", not "1 days".
 *
 * This string reaches a taxpayer on a notice explaining why a penalty arose.
 * A derivation that reads as though it were generated by a machine invites
 * exactly the challenge it exists to forestall.
 */
function plural(value: number, unit: string): string {
  const word = unit.toLowerCase();
  return `${value} ${value === 1 ? word.replace(/s$/, '') : word}`;
}

/**
 * Apply one offset.
 *
 * A unit nobody implemented must not silently become days, so the default
 * throws rather than guessing.
 */
function shift(
  date: Date,
  value: number,
  unit: string,
  businessDays: boolean,
  calendar: BusinessCalendar,
): Date {
  switch (unit) {
    case 'DAYS':
      // Only days are counted as working days. "Three working months" is not
      // a thing any statute says, and inventing a meaning for it would be
      // worse than refusing.
      return businessDays ? addBusinessDays(date, value, calendar) : addDays(date, value);
    case 'MONTHS':
      return addMonths(date, value);
    case 'YEARS':
      return addMonths(date, value * 12);
    default:
      throw new Error(
        `Deadline offset unit ${unit} is not implemented. ` +
          'Add it to DeadlineService rather than approximating it.',
      );
  }
}
