import { Sequelize } from 'sequelize';
import {
  InvalidPatternError,
  ReferenceNumberService,
  renderPattern,
} from '../src/forms/reference-number.service';
import { render } from '../src/platform/notification/notification.service';

/**
 * Reference numbers and template rendering.
 *
 * Plan reference: V2 sections 4.2, 11.1, 6.4.
 *
 * A case number appears on a served legal instrument. Two cases sharing one,
 * or a number that silently drops its year, is not a cosmetic defect.
 */

describe('renderPattern', () => {
  const at = new Date('2026-03-15T00:00:00Z');

  it('expands the year and pads the sequence width', () => {
    expect(renderPattern('TA{YYYY}{SEQ:8}', at)).toEqual({
      prefix: 'TA2026',
      sequenceWidth: 8,
    });
  });

  it('expands two-digit year and month', () => {
    expect(renderPattern('N{YY}{MM}{SEQ:4}', at)).toEqual({
      prefix: 'N2603',
      sequenceWidth: 4,
    });
  });

  it('handles a pattern with no sequence', () => {
    expect(renderPattern('FIXED-{YYYY}', at)).toEqual({
      prefix: 'FIXED-2026',
      sequenceWidth: null,
    });
  });

  it('rejects an unknown placeholder rather than emitting it literally', () => {
    // A case number reading `TA{QUARTER}0001` would be served on a notice.
    expect(() => renderPattern('TA{QUARTER}{SEQ:4}', at)).toThrow(InvalidPatternError);
    expect(() => renderPattern('TA{QUARTER}{SEQ:4}', at)).toThrow(/unknown placeholder/);
  });

  it('rejects more than one sequence placeholder', () => {
    expect(() => renderPattern('TA{SEQ:2}-{SEQ:2}', at)).toThrow(/more than one/);
  });

  it('requires the sequence at the end', () => {
    // A number embedded mid-string makes the prefix ambiguous, and the
    // sequence key is derived from the prefix.
    expect(() => renderPattern('TA{SEQ:4}-SUFFIX', at)).toThrow(/must end with/);
  });

  it('rejects an unusable sequence width', () => {
    expect(() => renderPattern('TA{SEQ:0}', at)).toThrow(/1\.\.18/);
    expect(() => renderPattern('TA{SEQ:99}', at)).toThrow(/1\.\.18/);
  });

  it('rejects an empty pattern', () => {
    expect(() => renderPattern('   ', at)).toThrow(/empty/);
  });
});

describe('ReferenceNumberService', () => {
  const sequelize = new Sequelize({
    dialect: 'postgres',
    host: process.env['DB_HOST'] ?? 'localhost',
    port: Number(process.env['DB_PORT'] ?? 5433),
    username: process.env['DB_USER'] ?? 'tas',
    password: process.env['DB_PASSWORD'] ?? 'tas_local_dev_only',
    database: process.env['DB_NAME'] ?? 'tax_assessment',
    logging: false,
  });

  const service = new ReferenceNumberService(sequelize);
  const pattern = `TEST{YYYY}{SEQ:6}`;

  beforeAll(async () => {
    await sequelize.authenticate();
    await sequelize.query(`DELETE FROM forms.reference_sequence WHERE sequence_key LIKE 'TEST%'`);
  });

  afterAll(async () => {
    await sequelize.query(`DELETE FROM forms.reference_sequence WHERE sequence_key LIKE 'TEST%'`);
    await sequelize.close();
  });

  it('starts at one and increments', async () => {
    const first = await service.allocate(pattern);
    const second = await service.allocate(pattern);
    expect(first).toMatch(/^TEST\d{4}000001$/);
    expect(second).toMatch(/^TEST\d{4}000002$/);
  });

  it('never issues the same number twice under concurrency', async () => {
    // The reason this is a sequence table and not max()+1. Two officers
    // initiating a case at the same moment must not both get the same number.
    const concurrent = await Promise.all(
      Array.from({ length: 25 }, () => service.allocate(pattern)),
    );
    expect(new Set(concurrent).size).toBe(25);
  });

  it('gives each year its own counter', async () => {
    const y2030 = await service.allocate(pattern, new Date('2030-01-01T00:00:00Z'));
    const y2031 = await service.allocate(pattern, new Date('2031-01-01T00:00:00Z'));
    expect(y2030).toBe('TEST2030000001');
    expect(y2031).toBe('TEST2031000001');
  });

  it('peeks without consuming', async () => {
    const peeked = await service.peek(pattern, new Date('2040-01-01T00:00:00Z'));
    const allocated = await service.allocate(pattern, new Date('2040-01-01T00:00:00Z'));
    expect(allocated).toBe(peeked);
  });

  it('returns the pattern itself when it has no sequence', async () => {
    expect(await service.allocate('TESTFIXED-{YYYY}', new Date('2026-01-01T00:00:00Z'))).toBe(
      'TESTFIXED-2026',
    );
  });
});

describe('notification template rendering', () => {
  it('substitutes placeholders', () => {
    expect(
      render('Case {{caseNumber}} assigned to {{officer}}', {
        caseNumber: 'TA-2026-1',
        officer: 'A. Assessor',
      }),
    ).toBe('Case TA-2026-1 assigned to A. Assessor');
  });

  it('leaves an unresolved placeholder visible rather than blank', () => {
    // "Please respond by " looks deliberate and would be served to a taxpayer.
    // "Please respond by {{responseDeadline}}" is obviously broken.
    expect(render('Please respond by {{responseDeadline}}', {})).toBe(
      'Please respond by {{responseDeadline}}',
    );
    expect(render('Value: {{missing}}', { missing: null })).toBe('Value: {{missing}}');
  });

  it('substitutes a numeric value', () => {
    expect(render('{{count}} days remaining', { count: 14 })).toBe('14 days remaining');
  });

  it('leaves text with no placeholders untouched', () => {
    expect(render('No placeholders here', { a: 1 })).toBe('No placeholders here');
  });
});
