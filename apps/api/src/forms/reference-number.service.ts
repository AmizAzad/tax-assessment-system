import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, Transaction, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../infrastructure/tokens';

/**
 * Allocates case and notice numbers from a configured pattern.
 *
 * Plan reference: V2 sections 4.2, 11.1, 13.4.
 *
 * ## Why this is not `max(number) + 1`
 *
 * Case numbers are quoted on legal instruments and must be unique. Two
 * officers initiating a case at the same moment would both read the same
 * maximum and allocate the same number. Some jurisdictions additionally
 * require them gapless, which a scan-and-increment cannot promise at all.
 *
 * So allocation takes a row lock on a sequence row. It is deliberately a
 * serialisation point: correctness of an identifier that appears on a served
 * notice matters more than the throughput of case creation.
 *
 * ## Pattern syntax
 *
 *   {YYYY}     four-digit year
 *   {YY}       two-digit year
 *   {MM}       two-digit month
 *   {SEQ:n}    zero-padded sequence, n digits
 *   anything else is literal
 *
 * `TA{YYYY}{SEQ:8}` produces `TA202600000001`.
 *
 * The sequence resets per distinct rendered prefix, so a `{YYYY}` pattern
 * restarts each year, which is what a tax authority expects.
 */
@Injectable()
export class ReferenceNumberService {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async allocate(pattern: string, at: Date = new Date()): Promise<string> {
    const { prefix, sequenceWidth } = renderPattern(pattern, at);

    if (sequenceWidth === null) {
      // No {SEQ} in the pattern: nothing to allocate, the pattern is the value.
      return prefix;
    }

    // The sequence key is the rendered prefix, so a {YYYY} pattern gets its
    // own counter each year rather than continuing from last year's.
    const sequenceKey = `${pattern}::${prefix}`;

    const next = await this.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        // INSERT ... ON CONFLICT DO UPDATE takes a row lock and returns the
        // incremented value atomically, so two concurrent callers serialise
        // rather than colliding.
        const rows = await this.sequelize.query<{ next_value: string }>(
          `INSERT INTO forms.reference_sequence (sequence_key, next_value)
                VALUES (:sequenceKey, 2)
           ON CONFLICT (sequence_key) DO UPDATE
                   SET next_value = forms.reference_sequence.next_value + 1,
                       updated_at = CURRENT_TIMESTAMP
             RETURNING next_value`,
          {
            type: QueryTypes.SELECT,
            replacements: { sequenceKey },
            transaction,
          },
        );
        // `next_value` holds the number to hand out *next*, and RETURNING
        // gives its post-write value in both branches: the insert writes 2
        // having consumed 1, and the update writes n+1 having consumed n. So
        // the number allocated is one less than what came back, uniformly.
        return Number(rows[0]!.next_value) - 1;
      },
    );

    return prefix + String(next).padStart(sequenceWidth, '0');
  }

  /** The next number without consuming it. For previews only. */
  async peek(pattern: string, at: Date = new Date()): Promise<string> {
    const { prefix, sequenceWidth } = renderPattern(pattern, at);
    if (sequenceWidth === null) {
      return prefix;
    }
    const sequenceKey = `${pattern}::${prefix}`;
    const rows = await this.sequelize.query<{ next_value: string }>(
      `SELECT next_value FROM forms.reference_sequence WHERE sequence_key = :sequenceKey`,
      { type: QueryTypes.SELECT, replacements: { sequenceKey } },
    );
    const next = rows[0] === undefined ? 1 : Number(rows[0].next_value);
    return prefix + String(next).padStart(sequenceWidth, '0');
  }
}

export class InvalidPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPatternError';
  }
}

/**
 * Expand the date tokens, and find the sequence placeholder.
 *
 * Exported for testing: pattern expansion is the part most likely to be got
 * subtly wrong, and it is cheap to test directly.
 */
export function renderPattern(
  pattern: string,
  at: Date,
): { prefix: string; sequenceWidth: number | null } {
  if (pattern.trim() === '') {
    throw new InvalidPatternError('Reference pattern is empty');
  }

  const sequenceMatches = pattern.match(/\{SEQ:(\d+)\}/g) ?? [];
  if (sequenceMatches.length > 1) {
    throw new InvalidPatternError(
      `Reference pattern '${pattern}' has more than one {SEQ} placeholder`,
    );
  }

  let sequenceWidth: number | null = null;
  let working = pattern;

  const sequenceMatch = /\{SEQ:(\d+)\}/.exec(pattern);
  if (sequenceMatch !== null) {
    const width = Number(sequenceMatch[1]);
    if (!Number.isInteger(width) || width < 1 || width > 18) {
      throw new InvalidPatternError(
        `Reference pattern '${pattern}' has an unusable sequence width; expected 1..18`,
      );
    }
    sequenceWidth = width;
    // A sequence is only meaningful at the end: a number embedded mid-string
    // would make the prefix ambiguous.
    if (!pattern.endsWith(sequenceMatch[0])) {
      throw new InvalidPatternError(
        `Reference pattern '${pattern}' must end with its {SEQ} placeholder`,
      );
    }
    working = pattern.slice(0, pattern.length - sequenceMatch[0].length);
  }

  const year = at.getUTCFullYear();
  const prefix = working
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, String(year % 100).padStart(2, '0'))
    .replace(/\{MM\}/g, String(at.getUTCMonth() + 1).padStart(2, '0'));

  const leftover = /\{[^}]*\}/.exec(prefix);
  if (leftover !== null) {
    throw new InvalidPatternError(
      `Reference pattern '${pattern}' contains an unknown placeholder '${leftover[0]}'`,
    );
  }

  return { prefix, sequenceWidth };
}
