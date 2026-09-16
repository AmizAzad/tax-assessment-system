import { expect, test } from './support/fixtures';

/**
 * Properties of the interface itself.
 *
 * Plan reference: V2 sections 18.3, 6.8; ADR-006, ADR-007.
 *
 * These are the things that are true of every screen rather than of one
 * workflow: a control has to stay visible when you point at it, a keyboard
 * has to reach the work, and a figure has to arrive on screen as the server
 * sent it.
 */

/** Parse `rgb(r, g, b)` into relative luminance, per WCAG. */
function luminance(colour: string): number {
  const parts = colour
    .match(/\d+(\.\d+)?/g)
    ?.slice(0, 3)
    .map(Number) ?? [0, 0, 0];
  const [r, g, b] = parts.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe('buttons', () => {
  /**
   * The regression this file was started for.
   *
   * A primary button used to disappear under the cursor: the shared
   * `.tas-btn:hover:not(:disabled)` rule is three selectors of specificity and
   * `.tas-btn--primary` is one, so hovering replaced the dark background with
   * the light one while the text stayed white. White on near-white.
   *
   * Asserting the computed contrast rather than a specific colour means the
   * test survives a rebrand and still fails if a variant loses half its pair.
   */
  test('stay readable while the pointer is over them', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    // The register's controls render once the caller's permissions are known,
    // so counting before that finds nothing and the test passes vacuously.
    await expect(page.getByRole('button', { name: 'Open a case' })).toBeVisible({
      timeout: 20_000,
    });

    const buttons = page.locator('.tas-btn:visible');
    const count = await buttons.count();
    expect(count, 'the register has buttons to check').toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      const label = (await button.innerText()).trim();

      await button.hover();

      const { colour, background } = await button.evaluate((element) => {
        const style = getComputedStyle(element);

        // A transparent background is not white — it is whatever is behind it.
        // Walking up for the first painted ancestor is what the eye does, and
        // comparing against `rgba(0, 0, 0, 0)` would score every ghost button
        // as perfect contrast against black.
        let painted = style.backgroundColor;
        let node: HTMLElement | null = element.parentElement;
        while (node !== null && /rgba\(0, 0, 0, 0\)|transparent/.test(painted)) {
          painted = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }

        return { colour: style.color, background: painted };
      });

      const ratio = contrastRatio(colour, background);

      // 4.5:1 is the WCAG AA threshold for body text. A button that vanishes
      // scores close to 1.
      expect(
        ratio,
        `"${label}" should stay legible on hover (${colour} on ${background})`,
      ).toBeGreaterThan(4.5);
    }
  });

  test('are legible before anyone points at them', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    const button = page.getByRole('button', { name: 'Open a case' });
    const { colour, background } = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { colour: style.color, background: style.backgroundColor };
    });

    expect(contrastRatio(colour, background)).toBeGreaterThan(4.5);
  });
});

test.describe('keyboard', () => {
  /**
   * Plan 18.3: keyboard navigation through the whole assessment flow.
   *
   * The skip link is the first thing a keyboard user meets. Without it, every
   * screen starts with the whole navigation bar again.
   */
  test('the first stop is a skip link', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    expect(focused).toBe('Skip to content');
  });

  test('focus is visible', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    await page.getByRole('button', { name: 'Open a case' }).focus();
    const outline = await page
      .getByRole('button', { name: 'Open a case' })
      .evaluate((element) => getComputedStyle(element).outlineWidth);

    // A focus ring a user cannot see is the same as no focus ring.
    expect(parseFloat(outline)).toBeGreaterThanOrEqual(2);
  });
});

test.describe('money on screen', () => {
  /**
   * ADR-007: the browser never parses a monetary string.
   *
   * A figure larger than a double can hold is the test that catches it — if
   * anything on the path went through `Number`, the last digits change.
   */
  test('a register amount is rendered digit for digit', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    const amounts = page.locator('td.tas-amount');
    await expect(amounts.first()).toBeVisible({ timeout: 20_000 });

    const rendered = await amounts.allInnerTexts();
    for (const value of rendered) {
      const text = value.trim();
      if (text === '' || text === '—') continue;

      // Grouped, two decimal places, and never in exponential notation —
      // which is what a number that has been through a double looks like.
      expect(text, 'an amount is formatted, not computed').toMatch(/^-?[\d,]+\.\d{2}( [A-Z]{3})?$/);
      expect(text).not.toContain('e+');
      expect(text).not.toContain('NaN');
    }
  });
});
