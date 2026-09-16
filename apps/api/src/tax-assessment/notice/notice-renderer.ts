import { createHash } from 'node:crypto';

/**
 * Turning a notice template and a set of facts into the text that is served.
 *
 * Plan reference: V2 sections 12.2, 12.3.
 *
 * ## Why substitution and nothing else
 *
 * A template may only substitute tokens. It cannot compute, branch, or call
 * anything. Every figure on a notice comes from the calculation that was
 * approved, and a template with an expression language could produce a number
 * that disagrees with it — a notice demanding a different sum from the one an
 * approver signed off (ADR-006).
 *
 * ## Why a missing token is fatal
 *
 * A notice that says "You must pay {{netPayable}} by {{dueDate}}" with an
 * unresolved token is not a notice, it is a defect that has been served on a
 * member of the public. Rendering throws rather than emitting the literal
 * braces or an empty string.
 */

export class NoticeRenderError extends Error {
  constructor(
    message: string,
    readonly missingTokens: readonly string[] = [],
  ) {
    super(message);
    this.name = 'NoticeRenderError';
  }
}

/** `{{token}}`, with optional surrounding spaces. */
const TOKEN_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;

/**
 * Any `{{...}}` at all, valid or not.
 *
 * Used to catch what `TOKEN_PATTERN` deliberately will not match: an
 * expression like `{{netPayable + 1}}`. Without this check such a placeholder
 * is simply not substituted, and the braces are printed verbatim on a legal
 * document. Refusing is the only safe reading, and it doubles as the guard
 * that keeps the template language free of arithmetic (ADR-006).
 */
const ANY_PLACEHOLDER_PATTERN = /\{\{[^}]*\}\}/g;

export interface RenderedNotice {
  readonly title: string;
  readonly body: string;
  /** The values actually substituted, stored so the notice can be re-rendered. */
  readonly content: Readonly<Record<string, string>>;
  /** SHA-256 over the canonical content, not over any rendered file. */
  readonly contentHash: string;
}

/**
 * Substitute tokens into a template.
 *
 * @throws NoticeRenderError if any token in the template has no value.
 */
export function renderNotice(
  titleTemplate: string,
  bodyTemplate: string,
  values: Readonly<Record<string, string>>,
): RenderedNotice {
  const missing = new Set<string>();

  const substitute = (template: string): string =>
    template.replace(TOKEN_PATTERN, (_match, token: string) => {
      const value = values[token];
      if (value === undefined) {
        missing.add(token);
        // Returned but never used: the throw below fires first. Kept so the
        // replace call stays total rather than returning undefined.
        return '';
      }
      return value;
    });

  const malformed = [...findMalformed(titleTemplate), ...findMalformed(bodyTemplate)];
  if (malformed.length > 0) {
    throw new NoticeRenderError(
      `The notice template contains placeholders that are not simple tokens: ` +
        `${malformed.join(', ')}. A template may substitute values and nothing else; it must ` +
        'not compute, because every figure on a notice comes from the approved calculation.',
    );
  }

  const title = substitute(titleTemplate);
  const body = substitute(bodyTemplate);

  if (missing.size > 0) {
    const tokens = [...missing].sort();
    throw new NoticeRenderError(
      `The notice template needs values that were not supplied: ${tokens.join(', ')}. ` +
        'A notice must not be served with unresolved placeholders.',
      tokens,
    );
  }

  return { title, body, content: values, contentHash: hashContent(title, body, values) };
}

/**
 * Placeholders that are not plain tokens.
 *
 * Returned rather than thrown so the caller can report all of them at once,
 * which is what an administrator fixing a template actually needs.
 */
function findMalformed(template: string): readonly string[] {
  const bad: string[] = [];
  for (const match of template.matchAll(ANY_PLACEHOLDER_PATTERN)) {
    const whole = match[0];
    // Re-test in isolation: a global regex carries lastIndex between calls.
    if (!/^\{\{\s*[A-Za-z][A-Za-z0-9_.]*\s*\}\}$/.test(whole)) {
      bad.push(whole);
    }
  }
  return bad;
}

/**
 * Which tokens a template uses.
 *
 * Used at publish time so a template that references a value the system cannot
 * supply is rejected by an administrator rather than discovered by a taxpayer.
 */
export function tokensIn(template: string): readonly string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/**
 * The hash that verification compares against.
 *
 * Over the content, not the PDF. A PDF embeds a creation timestamp, so the
 * same notice rendered twice produces different bytes and a byte hash would
 * report every re-render as tampering. Hashing the content answers the
 * question that actually matters: does this notice still say what it said when
 * it was served.
 *
 * Keys are sorted so the hash identifies the facts, not their key order.
 */
export function hashContent(
  title: string,
  body: string,
  values: Readonly<Record<string, string>>,
): string {
  const canonical = JSON.stringify({
    title,
    body,
    values: Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Render the notice as a PDF.
 *
 * `pdfkit` rather than a headless browser: a browser in the API image is a
 * large operational burden (sandboxing, memory, crash recovery) to buy layout
 * features a statutory notice does not need. A notice is a heading, some
 * paragraphs and a figure.
 *
 * ## The limitation, stated rather than hidden
 *
 * The built-in fonts are Latin-1. A notice in Arabic, Hindi or Chinese needs a
 * font embedded and, for Arabic, right-to-left shaping that pdfkit does not
 * perform. `renderPdf` therefore refuses a body it cannot faithfully draw
 * instead of emitting a PDF full of blanks and calling it served. The
 * canonical content is stored either way, so such a notice can still be
 * delivered through the portal while PDF support for that script is added.
 */
export async function renderPdf(notice: RenderedNotice, noticeNumber: string): Promise<Buffer> {
  assertRenderableInLatin(notice);

  // Required lazily so that a deployment which never issues PDFs does not pay
  // the module load, and so the import stays out of the unit tests that only
  // exercise substitution.
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: {
        Title: notice.title,
        Author: 'Tax Assessment System',
        Subject: noticeNumber,
        // Fixed, not `new Date()`. A varying timestamp would make two renders
        // of the same notice differ byte for byte, which is confusing when
        // the thing being compared is supposed to be identical.
        CreationDate: new Date(0),
      },
    });

    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    document.fontSize(16).font('Helvetica-Bold').text(notice.title, { align: 'left' });
    document.moveDown(0.5);
    document.fontSize(9).font('Helvetica').text(`Notice number: ${noticeNumber}`);
    document.moveDown(1);

    document.fontSize(11).font('Helvetica');
    for (const paragraph of notice.body.split(/\n{2,}/)) {
      document.text(paragraph.trim(), { align: 'left', lineGap: 2 });
      document.moveDown(0.8);
    }

    document.moveDown(1);
    document
      .fontSize(8)
      .fillColor('#555555')
      .text(
        `This notice may be verified against its content hash ${notice.contentHash.slice(0, 16)}.`,
      );

    document.end();
  });
}

/**
 * Refuse text the built-in fonts cannot draw.
 *
 * Silently dropping unsupported glyphs would produce a legally defective
 * notice that looks fine to whoever pressed the button.
 */
function assertRenderableInLatin(notice: RenderedNotice): void {
  // Escaped code points rather than literal characters. Written with literals
  // once, this class silently acquired a NUL, so the range meant to begin at a
  // space began at the null character instead: it tripped the linter and, worse,
  // quietly accepted every control character as printable.
  //
  // The set is Latin-1, plus the handful of punctuation marks the built-in
  // fonts carry, plus newline and carriage return because a notice body has
  // paragraphs.
  const unsupported = /[^\n\r\u0020-\u00FF\u2010-\u2015\u2018\u2019\u201C\u201D\u2026\u20AC]/u;
  for (const [label, text] of [
    ['title', notice.title],
    ['body', notice.body],
  ] as const) {
    const match = unsupported.exec(text);
    if (match !== null) {
      throw new NoticeRenderError(
        `The notice ${label} contains characters the built-in PDF fonts cannot draw ` +
          `(first at "${match[0]}"). Embed a font for this script before issuing PDFs in it; ` +
          'the notice content is stored and can be served through the portal meanwhile.',
      );
    }
  }
}
