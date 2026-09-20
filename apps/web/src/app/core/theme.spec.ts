import { backgroundImage, parsePreference, veilColour } from './theme';
import { SCENES } from './theme-scenes';

const DEFAULT = { mode: 'system', background: { kind: 'none' }, veil: 0.6 } as const;

/**
 * The appearance preference is read back out of browser storage, which is the
 * one input to this application that nobody validated on the way in: an older
 * build wrote it, a user edited it in devtools, or a full disk truncated it.
 *
 * What these tests are really about is that no such value can stop the
 * application starting, and that one bad field does not discard the fields
 * beside it.
 */
describe('parsePreference', () => {
  it('uses the default when nothing has been stored', () => {
    expect(parsePreference(null)).toEqual(DEFAULT);
  });

  it('uses the default when the stored value is not JSON', () => {
    expect(parsePreference('{"mode":')).toEqual(DEFAULT);
  });

  it('uses the default when the stored value is not an object', () => {
    expect(parsePreference('["dark"]')).toEqual(DEFAULT);
    expect(parsePreference('"dark"')).toEqual(DEFAULT);
  });

  it('keeps the fields it understands and defaults the rest', () => {
    expect(parsePreference('{"mode":"dark"}')).toEqual({
      mode: 'dark',
      background: { kind: 'none' },
      veil: 0.6,
    });
  });

  it('rejects a mode that is not one of the three', () => {
    expect(parsePreference('{"mode":"sepia"}').mode).toBe('system');
  });

  it('clamps a veil outside the slider range', () => {
    expect(parsePreference('{"veil":4}').veil).toBe(1);
    expect(parsePreference('{"veil":-2}').veil).toBe(0);
    expect(parsePreference('{"veil":0.35}').veil).toBe(0.35);
  });

  it('defaults a veil that is not a finite number rather than clamping it', () => {
    // JSON.parse turns an overflowing literal into Infinity, which would clamp
    // to a fully opaque veil and hide the chosen background entirely.
    expect(parsePreference('{"veil":1e999}').veil).toBe(0.6);
    expect(parsePreference('{"veil":"0.2"}').veil).toBe(0.6);
  });

  it('drops a corrupt background but keeps the mode stored beside it', () => {
    expect(parsePreference('{"mode":"light","background":{"kind":"colour"}}')).toEqual({
      mode: 'light',
      background: { kind: 'none' },
      veil: 0.6,
    });
  });

  it('rejects a preset id that no scene answers to', () => {
    expect(parsePreference('{"background":{"kind":"preset","id":"volcano"}}').background).toEqual({
      kind: 'none',
    });
    expect(parsePreference('{"background":{"kind":"preset","id":"mist"}}').background).toEqual({
      kind: 'preset',
      id: 'mist',
    });
  });

  it('rejects a colour that is not a six digit hex', () => {
    expect(parsePreference('{"background":{"kind":"colour","value":"red"}}').background).toEqual({
      kind: 'none',
    });
    expect(
      parsePreference('{"background":{"kind":"colour","value":"#1F4E79"}}').background,
    ).toEqual({ kind: 'colour', value: '#1F4E79' });
  });

  it('rejects anything that is not a base64 image data URL', () => {
    const notAnImage = '{"background":{"kind":"image","dataUrl":"data:text/html;base64,PHA+"}}';
    expect(parsePreference(notAnImage).background).toEqual({ kind: 'none' });

    const script = '{"background":{"kind":"image","dataUrl":"javascript:alert(1)"}}';
    expect(parsePreference(script).background).toEqual({ kind: 'none' });

    const png = '{"background":{"kind":"image","dataUrl":"data:image/png;base64,iVBORw0KGgo="}}';
    expect(parsePreference(png).background).toEqual({
      kind: 'image',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it('rejects a background kind the product does not offer', () => {
    expect(parsePreference('{"background":{"kind":"video","src":"x.mp4"}}').background).toEqual({
      kind: 'none',
    });
  });
});

describe('backgroundImage', () => {
  it('paints nothing when no background is chosen', () => {
    expect(backgroundImage({ kind: 'none' })).toBe('none');
  });

  it('paints a flat colour as a one-colour gradient', () => {
    expect(backgroundImage({ kind: 'colour', value: '#1f4e79' })).toBe(
      'linear-gradient(#1f4e79, #1f4e79)',
    );
  });

  it('paints an image data URL', () => {
    expect(backgroundImage({ kind: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })).toBe(
      'url("data:image/png;base64,iVBORw0KGgo=")',
    );
  });

  it('paints a bundled scene as its own data URL', () => {
    const css = backgroundImage({ kind: 'preset', id: 'mist' });
    expect(css.startsWith('url("data:image/svg+xml,%3Csvg')).toBe(true);
    expect(css.endsWith('%3C%2Fsvg%3E")')).toBe(true);
  });

  it('paints nothing rather than a value it would have to trust', () => {
    // Every one of these could have reached the CSS custom property from
    // browser storage, which nobody validated on the way in.
    expect(backgroundImage({ kind: 'colour', value: 'red; background: url(x)' })).toBe('none');
    expect(backgroundImage({ kind: 'image', dataUrl: 'javascript:alert(1)' })).toBe('none');
    expect(backgroundImage({ kind: 'preset', id: 'volcano' })).toBe('none');
  });
});

describe('veilColour', () => {
  it('mixes the page colour at the chosen strength', () => {
    expect(veilColour(0)).toBe('color-mix(in srgb, var(--tas-bg) 0%, transparent)');
    expect(veilColour(0.5)).toBe('color-mix(in srgb, var(--tas-bg) 50%, transparent)');
    expect(veilColour(1)).toBe('color-mix(in srgb, var(--tas-bg) 100%, transparent)');
  });

  it('rounds to a whole percentage', () => {
    expect(veilColour(0.375)).toBe('color-mix(in srgb, var(--tas-bg) 38%, transparent)');
  });

  it('clamps a strength outside the slider range', () => {
    expect(veilColour(4)).toBe('color-mix(in srgb, var(--tas-bg) 100%, transparent)');
    expect(veilColour(-1)).toBe('color-mix(in srgb, var(--tas-bg) 0%, transparent)');
  });
});

/**
 * The accessibility guarantee the bundled scenes carry: none of them paints
 * anything solid enough to change how legible body text is over it. A scene
 * added later that broke this would pass every other test in the suite and
 * fail only in the hands of the officer reading a register all afternoon.
 */
describe('the bundled scenes', () => {
  const markupOf = (dataUrl: string): string =>
    decodeURIComponent(dataUrl.slice('data:image/svg+xml,'.length));

  it('offers the four calm scenes by id', () => {
    expect(SCENES.map((scene) => scene.id)).toEqual(['mist', 'water', 'pines', 'dunes']);
  });

  it('paints every fill and every gradient stop at 0.18 alpha or less', () => {
    for (const scene of SCENES) {
      const markup = markupOf(scene.dataUrl);
      const alphas = [
        ...[...markup.matchAll(/rgba\([^)]*,\s*([0-9.]+)\)/g)].map((match) => Number(match[1])),
        ...[...markup.matchAll(/stop-opacity="([0-9.]+)"/g)].map((match) => Number(match[1])),
      ];
      expect(alphas.length).toBeGreaterThan(3);
      // The ceiling is measured: above it the light theme loses muted body
      // text on the page background, which has 4% of headroom over 4.5:1.
      expect(alphas.filter((alpha) => alpha > 0.18)).toEqual([]);
      expect(markup).not.toContain('<image');
      expect(markup).not.toContain('<script');
    }
  });

  it('slices to the viewport at one aspect ratio', () => {
    for (const scene of SCENES) {
      expect(markupOf(scene.dataUrl)).toContain(
        'viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"',
      );
    }
  });
});
