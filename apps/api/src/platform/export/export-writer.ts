import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import type { GridColumn } from '../grid/grid.model';

/**
 * Turning rows into a file an officer can open.
 *
 * Plan reference: V2 section 6.8.
 *
 * ## Two hazards this file exists to handle
 *
 * **Formula injection.** A spreadsheet treats a cell beginning `=`, `+`, `-`
 * or `@` as a formula. Taxpayer names, adjustment narratives and objection
 * grounds are typed by people, some of whom are the subject of an assessment
 * they dispute. A name of `=HYPERLINK("http://…"&A1)` becomes a live formula
 * in the officer's copy of Excel. Every text cell is therefore neutralised
 * with a leading apostrophe, which Excel strips on display and treats as
 * literal text.
 *
 * **Money.** Amounts arrive as exact decimal strings and are written as
 * strings (ADR-007). Writing them as numbers would put them through an
 * IEEE-754 double on the way into the file, and a `NUMERIC(20,4)` does not
 * survive that intact. The cost is that Excel will not sum the column without
 * a conversion, which is the right trade: an export that ties back to the
 * register is worth more than one that adds up to nearly the right number.
 */

/** Cells that a spreadsheet would otherwise evaluate. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function neutralise(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** Render one value for a file. Never rounds, never reformats a figure. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    // ISO-8601 in UTC. A locale-formatted date in an export is a date that
    // means something different in another office (plan 6.7).
    return value.toISOString();
  }
  return String(value);
}

export function csvCell(value: unknown): string {
  const text = neutralise(cellText(value));
  return /["\n\r,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(columns: readonly GridColumn[], row: Record<string, unknown>): string {
  return columns.map((column) => csvCell(row[column.key])).join(',');
}

export function csvHeader(columns: readonly GridColumn[]): string {
  return columns.map((column) => csvCell(column.label)).join(',');
}

/**
 * Build a workbook.
 *
 * `ExcelJS.stream.xlsx.WorkbookWriter` against a buffer rather than the
 * in-memory workbook: a register export is the one place in this system that
 * can legitimately be hundreds of thousands of rows, and the in-memory form
 * holds every cell as an object until the file is written.
 */
export async function writeXlsx(
  sheetName: string,
  columns: readonly GridColumn[],
  batches: AsyncIterable<readonly Record<string, unknown>[]>,
): Promise<{ body: Buffer; rowCount: number }> {
  // A real stream, not a hand-rolled sink: the writer pipes a zip archive
  // through it and relies on back-pressure and the stream's event contract.
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
  });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useStyles: false,
    useSharedStrings: false,
  });

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.addRow(columns.map((column) => column.label)).commit();

  let rowCount = 0;
  for await (const batch of batches) {
    for (const row of batch) {
      sheet.addRow(columns.map((column) => neutralise(cellText(row[column.key])))).commit();
      rowCount += 1;
    }
  }

  sheet.commit();
  await workbook.commit();
  await finished;

  return { body: Buffer.concat(chunks), rowCount };
}
