import { test as setup, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PASSWORD, ROLES, sessionFile } from './support/session';

/**
 * Sign in once per role, and keep the session.
 *
 * Plan reference: ADR-003.
 *
 * ## Why this is a real sign-in and not an injected token
 *
 * Minting a token with the password grant and writing it into storage would
 * be faster and would skip the thing most likely to break: the
 * authorisation-code redirect with PKCE, the audience mapper, and the
 * callback route. Those are part of what "can an officer use this system"
 * means, so every role goes through the actual Keycloak login form once.
 *
 * ## Why the session is saved by hand rather than with storageState
 *
 * `oidc-client-ts` is configured to keep the user in **sessionStorage** — a
 * token that outlives the tab outlives the reason it was issued. Playwright's
 * `storageState` captures cookies and localStorage and not sessionStorage, so
 * it would save a file containing nothing useful and every test would land on
 * the login page.
 *
 * So the setup reads sessionStorage out of the page and writes it to disk, and
 * the fixture puts it back with an init script before the app boots. The
 * comment is here because the alternative — changing the application to use
 * localStorage so the tests are easier — would be weakening a security
 * decision to suit a test runner.
 */
for (const role of ROLES) {
  setup(`sign in as ${role}`, async ({ page }) => {
    await page.goto('/');

    // The app redirects to Keycloak. Recognise its login form rather than a
    // URL, so a realm or port change does not silently pass.
    const username = page.locator('#username');
    await expect(username, 'the Keycloak login form should appear').toBeVisible({
      timeout: 30_000,
    });

    await username.fill(role);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#kc-login').click();

    // Back on the app, signed in. The shell renders the username, which is the
    // first thing that proves the token was accepted *and* that `/me`
    // answered — the two failures that look identical from outside.
    await expect(page.locator('.tas-shell__whoami')).toContainText(role, { timeout: 30_000 });

    const session = await page.evaluate(() => JSON.stringify(window.sessionStorage));

    const file = sessionFile(role);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, session, 'utf8');

    expect(JSON.parse(session), 'the session should contain an oidc user').not.toEqual({});
  });
}
