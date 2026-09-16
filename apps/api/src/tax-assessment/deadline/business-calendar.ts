/**
 * Working-day arithmetic.
 *
 * Plan reference: V2 sections 10.2, 10.4.
 *
 * ## Why this is separate from DeadlineService
 *
 * Date arithmetic that decides penalties deserves to be tested without a
 * database in the way. Everything here is pure: given a set of holidays and a
 * definition of the weekend, the answers are fixed.
 *
 * ## Plain dates, never instants
 *
 * Every date is a `YYYY-MM-DD` string manipulated through UTC. A statutory
 * deadline is a calendar date in the jurisdiction, not a moment. Running this
 * through a local-time `Date` would move it by a day for a server west of
 * Greenwich, which shows a return filed on the due date as one day late.
 */

/** Day-of-week codes, matching `Date.prototype.getUTCDay()` order. */
export const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type DayCode = (typeof DAY_CODES)[number];

/**
 * Which days are not working days, and which dates are holidays.
 *
 * The weekend is configurable because it is not Saturday and Sunday
 * everywhere: much of the Gulf works Sunday to Thursday. A platform that
 * hard-codes the western weekend cannot be configured for those jurisdictions,
 * which is the promise this system makes about adding one.
 */
export interface BusinessCalendar {
  readonly weekendDays: ReadonlySet<DayCode>;
  /** `YYYY-MM-DD` dates that are public holidays. */
  readonly holidays: ReadonlySet<string>;
}

export const DEFAULT_WEEKEND: ReadonlySet<DayCode> = new Set<DayCode>(['SAT', 'SUN']);

export function emptyCalendar(): BusinessCalendar {
  return { weekendDays: DEFAULT_WEEKEND, holidays: new Set() };
}

export function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) {
    throw new Error(`${value} is not a YYYY-MM-DD date.`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  // `2024-02-31` parses arithmetically into 2 March, which would silently move
  // a statutory date. Reject it instead.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${value} is not a real calendar date.`);
  }
  return date;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * Add months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 or 29 February, not 3 March. JavaScript's
 * native behaviour overflows into the next month, which moves a deadline past
 * the month the statute names.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

export function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

export function dayCodeOf(date: Date): DayCode {
  return DAY_CODES[date.getUTCDay()]!;
}

export function isBusinessDay(date: Date, calendar: BusinessCalendar): boolean {
  if (calendar.weekendDays.has(dayCodeOf(date))) return false;
  return !calendar.holidays.has(formatDate(date));
}

/**
 * The next business day on or after `date`.
 *
 * Used where a deadline computed in calendar days lands on a day the office is
 * shut. Rolling forward rather than back: moving a deadline earlier than the
 * statute allows shortens the taxpayer's time, which is the error that causes
 * harm.
 */
export function rollForwardToBusinessDay(date: Date, calendar: BusinessCalendar): Date {
  let candidate = date;
  // A guard, not an expectation. Without it a calendar that marked every day a
  // holiday would spin forever inside a request.
  for (let guard = 0; guard < 370; guard += 1) {
    if (isBusinessDay(candidate, calendar)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error(
    'No business day found within a year of the target date. The holiday calendar for this ' +
      'jurisdiction is almost certainly wrong.',
  );
}

/**
 * Add a number of business days, skipping weekends and holidays.
 *
 * Counting starts the day after `date`: "within 30 working days" does not
 * count the day the clock started, which is the convention every jurisdiction
 * I could find follows for service and objection windows.
 */
export function addBusinessDays(date: Date, days: number, calendar: BusinessCalendar): Date {
  if (days === 0) return rollForwardToBusinessDay(date, calendar);

  const step = days > 0 ? 1 : -1;
  let remaining = Math.abs(days);
  let candidate = date;

  while (remaining > 0) {
    candidate = addDays(candidate, step);
    if (isBusinessDay(candidate, calendar)) {
      remaining -= 1;
    }
  }
  return candidate;
}

/**
 * Whole days from `from` to `to`, never negative.
 *
 * Both are plain dates in UTC, so this is exact division with no DST hazard.
 * Negative means early, which is not lateness, so it clamps to zero rather
 * than producing a negative penalty.
 */
export function daysBetween(from: string, to: string): number {
  const difference = parseDate(to).getTime() - parseDate(from).getTime();
  return difference <= 0 ? 0 : Math.floor(difference / 86_400_000);
}

/** Today, as a plain UTC date. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
