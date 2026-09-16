import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';

export interface Language {
  readonly code: string;
  readonly displayName: string;
  readonly direction: 'LTR' | 'RTL';
  readonly isDefault: boolean;
}

/**
 * Display key resolution.
 *
 * Plan reference: V2 sections 6.7, 18.3.
 *
 * Every user-visible string in this system is a key, never literal text. That
 * is not only about translation: status codes, error codes and master data
 * items are shared vocabulary between the API, the SPA and the notice
 * templates, and a key is the only thing all three can agree on.
 *
 * ## Missing keys return the key
 *
 * An unresolved key renders as `ta.field.someThing` rather than blank or an
 * error. A missing translation should look obviously wrong in the UI and be
 * findable by grep, not silently produce an empty label on a tax notice.
 */
@Injectable()
export class I18nService {
  private readonly logger = new Logger(I18nService.name);

  /** language -> (key -> label). Rebuilt on demand; this data changes rarely. */
  private cache = new Map<string, Map<string, string>>();
  private languages: Language[] = [];

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async listLanguages(): Promise<readonly Language[]> {
    if (this.languages.length > 0) {
      return this.languages;
    }
    const rows = await this.sequelize.query<{
      language_code: string;
      display_name: string;
      direction: string;
      is_default: boolean;
    }>(
      `SELECT language_code, display_name, direction, is_default
         FROM platform.language
        WHERE is_active
        ORDER BY is_default DESC, language_code`,
      { type: QueryTypes.SELECT },
    );

    this.languages = rows.map((row) => ({
      code: row.language_code,
      displayName: row.display_name,
      direction: row.direction === 'RTL' ? 'RTL' : 'LTR',
      isDefault: row.is_default,
    }));
    return this.languages;
  }

  /** Every key for a language, for the SPA to load once at startup. */
  async bundle(languageCode: string): Promise<Readonly<Record<string, string>>> {
    const cached = this.cache.get(languageCode);
    if (cached !== undefined) {
      return Object.fromEntries(cached);
    }

    const rows = await this.sequelize.query<{ key: string; label: string }>(
      `SELECT k.key, l.label
         FROM platform.display_key k
         JOIN platform.display_key_label l ON l.display_key_id = k.id
        WHERE k.is_active AND l.is_active AND l.language_code = :languageCode`,
      { type: QueryTypes.SELECT, replacements: { languageCode } },
    );

    const bundle = new Map(rows.map((row) => [row.key, row.label]));
    this.cache.set(languageCode, bundle);
    this.logger.log(`Loaded ${bundle.size} display keys for '${languageCode}'`);
    return Object.fromEntries(bundle);
  }

  /**
   * Resolve one key.
   *
   * Falls back to the default language, then to the key itself. A notice must
   * never render a blank where a label should be.
   */
  async resolve(key: string, languageCode: string): Promise<string> {
    const bundle = await this.bundle(languageCode);
    const direct = bundle[key];
    if (direct !== undefined) {
      return direct;
    }

    const languages = await this.listLanguages();
    const fallback = languages.find((language) => language.isDefault);
    if (fallback !== undefined && fallback.code !== languageCode) {
      const fallbackBundle = await this.bundle(fallback.code);
      const viaFallback = fallbackBundle[key];
      if (viaFallback !== undefined) {
        return viaFallback;
      }
    }

    return key;
  }

  /** Register keys, idempotently. Used by migrations and by seeding tools. */
  async upsertKeys(
    entries: ReadonlyArray<{ key: string; languageCode: string; label: string }>,
  ): Promise<number> {
    for (const entry of entries) {
      await this.sequelize.query(
        `WITH upserted_key AS (
           INSERT INTO platform.display_key (key)
                VALUES (:key)
           ON CONFLICT (key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
             RETURNING id
         )
         INSERT INTO platform.display_key_label (display_key_id, language_code, label)
              SELECT id, :languageCode, :label FROM upserted_key
         ON CONFLICT (display_key_id, language_code) DO UPDATE
                 SET label = EXCLUDED.label, updated_at = CURRENT_TIMESTAMP`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            key: entry.key,
            languageCode: entry.languageCode,
            label: entry.label,
          },
        },
      );
    }
    this.invalidate();
    return entries.length;
  }

  invalidate(): void {
    this.cache.clear();
    this.languages = [];
  }
}
