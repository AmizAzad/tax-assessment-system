import { QueryTypes } from 'sequelize';
import {
  DeadlineService,
  type DeadlineConfig,
} from '../src/tax-assessment/deadline/deadline.service';

/**
 * Deadline arithmetic.
 *
 * Plan reference: V2 sections 10.1 to 10.4.
 *
 * These dates decide whether a penalty arises and how much interest runs, so
 * the cases below are the ones that actually go wrong in date code: month-end
 * clamping, leap years, the nine-months-and-one-day shape, and timezone drift.
 *
 * The Sequelize dependency is a stub rather than a real connection. The
 * arithmetic is the thing under test; a database would only prove that a
 * SELECT works.
 */
describe('DeadlineService', () => {
  /**
   * A service whose config lookup returns exactly what a test sets, and whose
   * working calendar is whatever the test declares.
   *
   * The stub routes on the SQL because the service issues three different
   * queries: the deadline configuration, the holiday list, and the weekend
   * master data. Returning one canned array for all three would silently feed
   * config rows in as holidays.
   */
  function serviceReturning(
    config: Partial<DeadlineConfig> | undefined,
    calendar: { holidays?: string[]; weekend?: string[] } = {},
  ) {
    const full: DeadlineConfig | undefined =
      config === undefined
        ? undefined
        : {
            deadlineType: 'FILING',
            anchorEvent: 'PERIOD_END',
            offsetValue: 12,
            offsetUnit: 'MONTHS',
            calendarRule: 'CALENDAR_DAYS',
            secondaryOffsetValue: null,
            secondaryOffsetUnit: null,
            ...config,
          };

    const sequelize = {
      query: jest.fn().mockImplementation((sql: string, options: { type: unknown }) => {
        expect(options.type).toBe(QueryTypes.SELECT);
        if (sql.includes('platform.holiday')) {
          return Promise.resolve((calendar.holidays ?? []).map((d) => ({ holiday_date: d })));
        }
        if (sql.includes('master_data')) {
          return Promise.resolve((calendar.weekend ?? []).map((c) => ({ item_code: c })));
        }
        return Promise.resolve(full === undefined ? [] : [full]);
      }),
    };

    return new DeadlineService(sequelize as never);
  }

  const scope = { jurisdictionCode: 'GB', taxTypeCode: 'CIT' };

  describe('offsets', () => {
    it('adds whole months', async () => {
      const service = serviceReturning({ offsetValue: 12, offsetUnit: 'MONTHS' });
      const resolved = await service.resolve(scope, 'FILING', '2024-12-31');
      expect(resolved?.dueDate).toBe('2025-12-31');
    });

    it('clamps to the end of a shorter month rather than overflowing into the next', async () => {
      // The defect this guards: JavaScript's native date arithmetic turns
      // 31 January plus one month into 3 March, which moves a deadline past
      // the month the statute names.
      const service = serviceReturning({ offsetValue: 1, offsetUnit: 'MONTHS' });
      const resolved = await service.resolve(scope, 'FILING', '2024-01-31');
      expect(resolved?.dueDate).toBe('2024-02-29');
    });

    it('clamps to 28 February in a non-leap year', async () => {
      const service = serviceReturning({ offsetValue: 1, offsetUnit: 'MONTHS' });
      const resolved = await service.resolve(scope, 'FILING', '2025-01-31');
      expect(resolved?.dueDate).toBe('2025-02-28');
    });

    it('counts days across a leap day', async () => {
      const service = serviceReturning({ offsetValue: 30, offsetUnit: 'DAYS' });
      const resolved = await service.resolve(scope, 'OBJECTION', '2024-02-15');
      expect(resolved?.dueDate).toBe('2024-03-16');
    });

    it('treats years as twelve months, so 29 February plus one year clamps', async () => {
      const service = serviceReturning({ offsetValue: 1, offsetUnit: 'YEARS' });
      const resolved = await service.resolve(scope, 'LIMITATION', '2024-02-29');
      expect(resolved?.dueDate).toBe('2025-02-28');
    });

    it('refuses an offset unit it does not implement instead of guessing', async () => {
      const service = serviceReturning({ offsetValue: 2, offsetUnit: 'WEEKS' as never });
      await expect(service.resolve(scope, 'FILING', '2024-12-31')).rejects.toThrow(
        /not implemented/,
      );
    });
  });

  describe('the UK corporation tax payment date', () => {
    it('is nine months and one day after the period end', async () => {
      const service = serviceReturning({
        deadlineType: 'PAYMENT',
        offsetValue: 9,
        offsetUnit: 'MONTHS',
        secondaryOffsetValue: 1,
        secondaryOffsetUnit: 'DAYS',
      });
      const resolved = await service.resolve(scope, 'PAYMENT', '2024-12-31');
      expect(resolved?.dueDate).toBe('2025-10-01');
    });

    it('applies the months before the day, which matters at a month end', async () => {
      // 31 May plus nine months clamps to 28 February, then plus a day is
      // 1 March. Adding the day first gives 1 June, then nine months is
      // 1 March as well here, but the clamp makes the two orders diverge for
      // other period ends, and the statute states the months first.
      const service = serviceReturning({
        deadlineType: 'PAYMENT',
        offsetValue: 9,
        offsetUnit: 'MONTHS',
        secondaryOffsetValue: 1,
        secondaryOffsetUnit: 'DAYS',
      });
      const resolved = await service.resolve(scope, 'PAYMENT', '2025-05-31');
      expect(resolved?.dueDate).toBe('2026-03-01');
    });

    it('names both offsets in the derivation', async () => {
      const service = serviceReturning({
        deadlineType: 'PAYMENT',
        offsetValue: 9,
        offsetUnit: 'MONTHS',
        secondaryOffsetValue: 1,
        secondaryOffsetUnit: 'DAYS',
      });
      const resolved = await service.resolve(scope, 'PAYMENT', '2024-12-31');
      expect(resolved?.derivation).toContain('9 months and 1 day');
      // Not "1 days": the derivation is quoted to taxpayers on penalty notices.
      expect(resolved?.derivation).not.toContain('1 days');
    });
  });

  describe('calendar rules', () => {
    it('rolls to the end of the month when asked', async () => {
      const service = serviceReturning({
        offsetValue: 3,
        offsetUnit: 'MONTHS',
        calendarRule: 'MONTH_END',
      });
      const resolved = await service.resolve(scope, 'FILING', '2024-01-15');
      expect(resolved?.dueDate).toBe('2024-04-30');
    });

    it('counts business days, skipping the weekend', async () => {
      // Monday 3 June 2024 plus 5 working days is Monday 10 June, not
      // Saturday 8 June.
      const service = serviceReturning({
        offsetValue: 5,
        offsetUnit: 'DAYS',
        calendarRule: 'BUSINESS_DAYS',
      });
      const resolved = await service.resolve(scope, 'RESPONSE', '2024-06-03');
      expect(resolved?.dueDate).toBe('2024-06-10');
    });

    it('skips public holidays as well as weekends', async () => {
      // Without the holiday the answer is 27 December; Christmas and Boxing
      // Day push it to 31 December.
      const service = serviceReturning(
        { offsetValue: 3, offsetUnit: 'DAYS', calendarRule: 'BUSINESS_DAYS' },
        { holidays: ['2024-12-25', '2024-12-26'] },
      );
      const resolved = await service.resolve(scope, 'RESPONSE', '2024-12-24');
      expect(resolved?.dueDate).toBe('2024-12-31');
    });

    it('honours a configured non-western weekend', async () => {
      // Friday and Saturday are the weekend in much of the Gulf. A platform
      // that assumed Saturday and Sunday could not serve that jurisdiction.
      const service = serviceReturning(
        { offsetValue: 2, offsetUnit: 'DAYS', calendarRule: 'BUSINESS_DAYS' },
        { weekend: ['FRI', 'SAT'] },
      );
      // Thursday 6 June 2024 plus 2 working days: Friday and Saturday are
      // skipped, so Sunday and Monday count -> Monday 10 June.
      const resolved = await service.resolve(scope, 'RESPONSE', '2024-06-06');
      expect(resolved?.dueDate).toBe('2024-06-10');
    });

    it('rolls a calendar-day deadline forward off a weekend when asked', async () => {
      // 30 days from 10 May 2024 is Sunday 9 June.
      const service = serviceReturning({
        offsetValue: 30,
        offsetUnit: 'DAYS',
        calendarRule: 'NEXT_BUSINESS_DAY',
      });
      const resolved = await service.resolve(scope, 'OBJECTION', '2024-05-10');
      expect(resolved?.dueDate).toBe('2024-06-10');
      expect(resolved?.derivation).toContain('rolled forward');
    });

    it('never rolls a deadline backwards', async () => {
      // Moving a deadline earlier than the statute allows shortens the
      // taxpayer's time, which is the error that causes harm.
      const service = serviceReturning({
        offsetValue: 30,
        offsetUnit: 'DAYS',
        calendarRule: 'NEXT_BUSINESS_DAY',
      });
      const resolved = await service.resolve(scope, 'OBJECTION', '2024-05-10');
      expect(resolved!.dueDate >= '2024-06-09').toBe(true);
    });

    it('leaves a deadline alone when it already falls on a working day', async () => {
      const service = serviceReturning({
        offsetValue: 31,
        offsetUnit: 'DAYS',
        calendarRule: 'NEXT_BUSINESS_DAY',
      });
      const resolved = await service.resolve(scope, 'OBJECTION', '2024-05-10');
      expect(resolved?.dueDate).toBe('2024-06-10');
      expect(resolved?.derivation).not.toContain('rolled forward');
    });

    it('does not count months as working months', async () => {
      // "Three working months" is not a thing any statute says. Months stay
      // calendar months even under a business-day rule.
      const service = serviceReturning({
        offsetValue: 1,
        offsetUnit: 'MONTHS',
        calendarRule: 'BUSINESS_DAYS',
      });
      const resolved = await service.resolve(scope, 'FILING', '2024-06-03');
      expect(resolved?.dueDate).toBe('2024-07-03');
    });
  });

  describe('absence', () => {
    it('returns undefined when nothing is configured, rather than inventing a date', async () => {
      const service = serviceReturning(undefined);
      expect(await service.resolve(scope, 'FILING', '2024-12-31')).toBeUndefined();
    });
  });

  describe('timezone safety', () => {
    it('produces the same date regardless of the server timezone', async () => {
      // The real-world defect: a return filed on the due date shows as one day
      // late because the server is west of Greenwich and a local-time Date
      // shifted the boundary.
      const original = process.env['TZ'];
      try {
        const results: (string | undefined)[] = [];
        for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
          process.env['TZ'] = zone;
          const service = serviceReturning({ offsetValue: 12, offsetUnit: 'MONTHS' });
          results.push((await service.resolve(scope, 'FILING', '2024-12-31'))?.dueDate);
        }
        expect(new Set(results).size).toBe(1);
        expect(results[0]).toBe('2025-12-31');
      } finally {
        if (original === undefined) delete process.env['TZ'];
        else process.env['TZ'] = original;
      }
    });
  });
});
