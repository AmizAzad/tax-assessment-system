import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Sequelize } from 'sequelize';
import { GridService } from '../src/platform/grid/grid.service';
import type { GridSource } from '../src/platform/grid/grid.model';
import { registerScopeClause, seesWholeRegister } from '../src/tax-assessment/case/register-scope';

/**
 * Configurable registers, and the boundary that makes them safe.
 *
 * Plan reference: V2 sections 6.8, 9.1, 20.
 *
 * A grid definition lives in the database and can be edited from an
 * administration screen. That is only acceptable because a definition names a
 * **column key**, never SQL: the server resolves the key against a fixed
 * allowlist supplied by the code. These tests are the evidence that the
 * allowlist is the thing deciding, and that the `sort` query parameter — the
 * one place a caller's text comes closest to an ORDER BY — cannot get past it.
 */

const source: GridSource = {
  gridKey: 'TEST_REGISTER',
  sortable: {
    caseNumber: 'c.case_number',
    openedAt: 'c.opened_at',
  },
  page: async () => ({ rows: [], total: 0 }),
  // eslint-disable-next-line require-yield
  stream: async function* () {
    return;
  },
};

describe('grid service', () => {
  const grids = new GridService({} as Sequelize);
  grids.register(source);

  describe('sort', () => {
    it('accepts a sortable column', () => {
      expect(grids.resolveSort(source, 'caseNumber:desc')).toEqual({
        key: 'caseNumber',
        direction: 'desc',
      });
    });

    it('defaults to ascending when no direction is given', () => {
      expect(grids.resolveSort(source, 'openedAt')).toEqual({
        key: 'openedAt',
        direction: 'asc',
      });
    });

    it('treats no sort as no sort rather than as a default column', () => {
      expect(grids.resolveSort(source, undefined)).toBeUndefined();
      expect(grids.resolveSort(source, '')).toBeUndefined();
    });

    it('refuses a column the register does not offer', () => {
      expect(() => grids.resolveSort(source, 'salary:asc')).toThrow(BadRequestException);
    });

    /**
     * The reason the allowlist exists. Every one of these is refused before
     * anything reaches SQL, and the refusal is on the *key*, so no amount of
     * quoting or encoding changes the answer.
     */
    it.each([
      'c.case_number; DROP TABLE tax.tax_assessment_case;--',
      '(SELECT 1)',
      "caseNumber' OR '1'='1",
      'case_number/**/',
    ])('refuses %s', (attempt) => {
      expect(() => grids.resolveSort(source, `${attempt}:asc`)).toThrow(BadRequestException);
    });

    it('refuses a direction that is not asc or desc', () => {
      expect(() => grids.resolveSort(source, 'caseNumber:asc;DROP TABLE x')).toThrow(
        BadRequestException,
      );
    });

    it('names the sortable columns when it refuses one', () => {
      expect(() => grids.resolveSort(source, 'nope:asc')).toThrow(/caseNumber, openedAt/);
    });
  });

  describe('registry', () => {
    it('refuses a register nobody has published', () => {
      expect(() => grids.source('NO_SUCH_GRID')).toThrow(NotFoundException);
    });

    it('returns a registered register', () => {
      expect(grids.source('TEST_REGISTER')).toBe(source);
    });
  });
});

/**
 * Who sees which cases.
 *
 * The register, the dashboard and the export all ask this one function, so a
 * change here changes all three together. The test that matters is the shape
 * of the predicate for a caseworker: it must bind `:callerId` rather than
 * interpolating it, and it must restrict by assignment.
 */
describe('register scope', () => {
  it('lets oversight roles see the whole register', () => {
    expect(seesWholeRegister(['TA_SUPERVISOR'])).toBe(true);
    expect(seesWholeRegister(['TA_ADMIN'])).toBe(true);
    expect(seesWholeRegister(['TA_AUDITOR_READONLY'])).toBe(true);
    expect(registerScopeClause(['TA_ADMIN'])).toBe('TRUE');
  });

  it('restricts a caseworker to their own assignments', () => {
    expect(seesWholeRegister(['TA_ASSESSOR'])).toBe(false);
    const clause = registerScopeClause(['TA_ASSESSOR']);
    expect(clause).toContain('tax_assessment_assignment');
    expect(clause).toContain(':callerId');
  });

  it('restricts a caller with no roles at all', () => {
    expect(seesWholeRegister([])).toBe(false);
    expect(registerScopeClause([])).toContain('tax_assessment_assignment');
  });

  it('does not let a taxpayer role widen the scope', () => {
    expect(seesWholeRegister(['TA_TAXPAYER'])).toBe(false);
  });

  it('binds the caller rather than interpolating it', () => {
    // If this ever becomes string concatenation, the register becomes
    // injectable through whatever supplies the user id.
    expect(registerScopeClause(['TA_ASSESSOR'])).not.toMatch(/user_id\s*=\s*\d/);
  });
});
