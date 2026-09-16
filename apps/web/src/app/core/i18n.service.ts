import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { APP_CONFIG } from './config';

export interface Language {
  readonly code: string;
  readonly displayName: string;
  readonly direction: 'LTR' | 'RTL';
  readonly isDefault: boolean;
}

/**
 * Display key resolution in the browser.
 *
 * Plan reference: V2 sections 6.7, 18.3.
 *
 * An unresolved key renders as the key itself, matching the server. A missing
 * translation should look obviously wrong and be findable by grep, not render
 * as a blank label on a screen an officer is meant to act on.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly api = inject(ApiService);

  private bundle: Record<string, string> = {};

  readonly languages = signal<readonly Language[]>([]);
  readonly current = signal<string>(APP_CONFIG.defaultLanguage);
  readonly direction = signal<'ltr' | 'rtl'>('ltr');

  async load(languageCode = APP_CONFIG.defaultLanguage): Promise<void> {
    const languages = await this.api.get<Language[]>('/i18n/languages');
    this.languages.set(languages);

    this.bundle = await this.api.get<Record<string, string>>(`/i18n/bundle/${languageCode}`);
    this.current.set(languageCode);

    const language = languages.find((entry) => entry.code === languageCode);
    const direction = language?.direction === 'RTL' ? 'rtl' : 'ltr';
    this.direction.set(direction);

    // RTL is set on the document rather than per-component: mirroring has to
    // apply to layout, scrollbars and form controls, not just text.
    document.documentElement.setAttribute('dir', direction);
    document.documentElement.setAttribute('lang', languageCode);
  }

  /** Resolve a key, falling back to the key itself. */
  t(key: string, fallback?: string): string {
    return this.bundle[key] ?? fallback ?? key;
  }
}
