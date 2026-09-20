import { Injectable, computed, effect, signal } from '@angular/core';
import {
  Background,
  THEME_STORAGE_KEY,
  ThemeMode,
  ThemePreference,
  backgroundImage,
  parsePreference,
  veilColour,
} from './theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStorage(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : null;
}

/**
 * The chosen appearance, applied to the document.
 *
 * Plan reference: V2 section 18.3.
 *
 * The preference is stored per device and deliberately never sent to the
 * server: an officer's wallpaper is not tax data, and putting it in the
 * profile would make a cosmetic choice something the API has to hold, version
 * and audit.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly stored = signal<ThemePreference>(parsePreference(readStorage()));

  readonly preference = this.stored.asReadonly();

  private readonly systemQuery = darkQuery();

  private readonly systemDark = signal(this.systemQuery?.matches ?? false);

  readonly resolvedMode = computed<'light' | 'dark'>(() => {
    const mode = this.stored().mode;
    if (mode !== 'system') return mode;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    // Listening, rather than only reading `matches` at boot, is what makes
    // "Match my device" follow the operating system while the application is
    // open: an officer whose machine switches to dark at dusk should not have
    // to reload to get it.
    this.systemQuery?.addEventListener('change', (event) => this.systemDark.set(event.matches));

    effect(() => {
      const preference = this.stored();
      const root = document.documentElement;

      // Set on light as well as dark. The light value matches no rule in the
      // stylesheet, so it costs nothing, and having the attribute always
      // present means the applied mode is readable from the DOM by a test and
      // by a person with devtools open.
      root.dataset['theme'] = this.resolvedMode();
      root.style.setProperty('--tas-bg-image', backgroundImage(preference.background));
      root.style.setProperty('--tas-bg-veil', veilColour(preference.veil));
    });
  }

  setMode(mode: ThemeMode): boolean {
    return this.update({ ...this.stored(), mode });
  }

  setBackground(background: Background): boolean {
    return this.update({ ...this.stored(), background });
  }

  setVeil(veil: number): boolean {
    return this.update({ ...this.stored(), veil });
  }

  /**
   * Apply a preference, or leave the previous one in place if it will not
   * persist.
   *
   * The revert is the point. An image too large for this device's storage
   * would otherwise be painted on screen and gone on the next reload, which
   * reads as the application losing the setting rather than refusing it. The
   * caller gets `false` and says so.
   */
  private update(next: ThemePreference): boolean {
    const previous = this.stored();
    this.stored.set(next);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next));
      return true;
    } catch {
      this.stored.set(previous);
      return false;
    }
  }
}
