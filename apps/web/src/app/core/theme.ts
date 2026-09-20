import { findScene } from './theme-scenes';

/**
 * What an officer has chosen for the look of the application.
 *
 * Plan reference: V2 section 18.3.
 *
 * `Background` is a discriminated union rather than a bag of optional fields,
 * so "a colour and an image at once" and "a preset with no id" cannot be
 * written down, and every reader of a preference handles exactly the four
 * cases the product offers.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export type Background =
  | { readonly kind: 'none' }
  | { readonly kind: 'colour'; readonly value: string }
  | { readonly kind: 'preset'; readonly id: string }
  | { readonly kind: 'image'; readonly dataUrl: string };

export interface ThemePreference {
  readonly mode: ThemeMode;
  readonly background: Background;
  readonly veil: number;
}

export const THEME_STORAGE_KEY = 'tas.appearance';

/**
 * The default veil is a measurement, not a taste. Driving the register in
 * Chromium and compositing the scene pixels under the veil and over the page
 * colour, 0.6 is the point at which all four bundled scenes hold 4.5:1 for
 * every text-and-backdrop pair in both themes; at 0.45, Morning mist and Pine
 * ridge drop muted body text to 4.49 and 4.47 in the light theme. It is a
 * floor a reader can lower for their own screen, not a preference.
 */
export const DEFAULT_PREFERENCE: ThemePreference = {
  mode: 'system',
  background: { kind: 'none' },
  veil: 0.6,
};

/** Browser storage is a few megabytes in total, shared with drafts. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const COLOUR_VALUE = /^#[0-9a-f]{6}$/i;

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export function isImageDataUrl(value: string): boolean {
  return IMAGE_DATA_URL.test(value);
}

function clamp(veil: number): number {
  return Math.min(1, Math.max(0, veil));
}

function parseMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_PREFERENCE.mode;
}

function parseVeil(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value)
    : DEFAULT_PREFERENCE.veil;
}

function parseBackground(value: unknown): Background {
  if (typeof value !== 'object' || value === null) return { kind: 'none' };
  const record = value as Record<string, unknown>;
  switch (record['kind']) {
    case 'none':
      return { kind: 'none' };
    case 'colour':
      return typeof record['value'] === 'string' && COLOUR_VALUE.test(record['value'])
        ? { kind: 'colour', value: record['value'] }
        : { kind: 'none' };
    case 'preset':
      return typeof record['id'] === 'string' && findScene(record['id']) !== undefined
        ? { kind: 'preset', id: record['id'] }
        : { kind: 'none' };
    case 'image':
      return typeof record['dataUrl'] === 'string' && isImageDataUrl(record['dataUrl'])
        ? { kind: 'image', dataUrl: record['dataUrl'] }
        : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Turn whatever is in storage into a preference the application can use.
 *
 * Validated field by field rather than all-or-nothing: a stored object whose
 * background was written by an older build, or truncated by a full disk, keeps
 * the mode the officer chose instead of resetting the whole appearance. There
 * is no input here that throws, because the alternative -- letting a corrupt
 * key propagate -- is an application that will not start until somebody clears
 * their browser storage.
 */
export function parsePreference(raw: string | null): ThemePreference {
  if (raw === null) return DEFAULT_PREFERENCE;

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCE;
  }

  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_PREFERENCE;
  }

  const record = stored as Record<string, unknown>;
  return {
    mode: parseMode(record['mode']),
    background: parseBackground(record['background']),
    veil: parseVeil(record['veil']),
  };
}

/**
 * The CSS value for `--tas-bg-image`.
 *
 * This switch is the single place that knows how a kind becomes CSS, so a
 * fifth kind later is one new case here rather than a new branch in the
 * service and another in the component. Values that came from storage are
 * re-checked before they are interpolated, because this string is handed
 * straight to the style attribute of the document element.
 */
export function backgroundImage(background: Background): string {
  switch (background.kind) {
    case 'none':
      return 'none';
    case 'colour':
      // A flat colour goes through the same image slot as everything else, so
      // the veil and the `cover`/`fixed` painting rule apply uniformly and
      // there is one code path rather than a colour-only special case.
      return COLOUR_VALUE.test(background.value)
        ? `linear-gradient(${background.value}, ${background.value})`
        : 'none';
    case 'preset': {
      const scene = findScene(background.id);
      return scene === undefined ? 'none' : `url("${scene.dataUrl}")`;
    }
    case 'image':
      return isImageDataUrl(background.dataUrl) ? `url("${background.dataUrl}")` : 'none';
  }
}

/**
 * The CSS value for `--tas-bg-veil`.
 *
 * The veil is the *page colour* at partial alpha, so it has to track
 * `--tas-bg` rather than be a literal that would be wrong the moment the
 * theme changed or a deployment rebranded. `color-mix` keeps that
 * substitution in CSS, which is what lets the service write one value that
 * stays correct in both themes instead of reading computed styles back out of
 * the document to find the current page colour.
 */
export function veilColour(veil: number): string {
  return `color-mix(in srgb, var(--tas-bg) ${Math.round(clamp(veil) * 100)}%, transparent)`;
}
