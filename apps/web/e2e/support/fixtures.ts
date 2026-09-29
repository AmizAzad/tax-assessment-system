import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PASSWORD, sessionFile, type Role } from './session';

const KEYCLOAK = process.env['E2E_KEYCLOAK'] ?? 'http://localhost:8085';
const API = process.env['E2E_API'] ?? 'http://localhost:3000';

/**
 * Fixtures for the end-to-end suite.
 *
 * Plan reference: V2 section 26.1.
 *
 * The central one is `as(role)`: a page already signed in as that officer. A
 * lifecycle test needs six different people to act on the same case in order,
 * and logging each of them in through the form every time would make the
 * suite take longer than it is worth.
 */

/**
 * Open a page carrying a role's saved session.
 *
 * The session is injected **before** any script runs, so the application
 * restores it during bootstrap exactly as it would for a returning user. A
 * login performed after load would test a different path from the one a
 * person takes.
 */
export async function openAs(browser: Browser, role: Role): Promise<Page> {
  const context = await browser.newContext();
  const session = readFileSync(sessionFile(role), 'utf8');

  await context.addInitScript((stored: string) => {
    const entries = JSON.parse(stored) as Record<string, string>;
    for (const [key, value] of Object.entries(entries)) {
      window.sessionStorage.setItem(key, value);
    }
  }, session);

  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.tas-shell__whoami')).toContainText(role, { timeout: 30_000 });
  return page;
}

/**
 * A token for talking to the API directly.
 *
 * Used only to **arrange** state a test needs and to **assert** what the
 * server actually holds. Never to perform the act under test: a lifecycle
 * test that moved the case by API and then checked the screen would prove
 * nothing about the screen.
 */
export async function apiToken(role: Role): Promise<string> {
  const response = await fetch(`${KEYCLOAK}/realms/tax-assessment/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'tas-web',
      username: role,
      password: PASSWORD,
      grant_type: 'password',
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not obtain a token for ${role}: HTTP ${response.status}`);
  }
  return (await response.json()).access_token;
}

/** The status code the API answers a role with. For the refusals. */
export async function apiStatus(role: Role, path: string): Promise<number> {
  const token = await apiToken(role);
  const response = await fetch(`${API}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.status;
}

export async function apiGet<T>(role: Role, path: string): Promise<T> {
  const token = await apiToken(role);
  const response = await fetch(`${API}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} as ${role}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * The company the suite assesses: whoever `acme-finance` acts for.
 *
 * Asked rather than assumed. Ids come from the order rows were written in,
 * and the second-jurisdiction migration writes Najd before the seed writes
 * Acme, so on a fresh stack "taxpayer 1" is a Saudi company. A hard-coded id
 * opened the case on one taxpayer while `freeAssessmentYear` checked another,
 * and the run failed at "open a case" on a year it had just called free.
 *
 * The portal answers from the recorded authority, so this also fails loudly
 * if the taxpayer login acts for nobody — which the portal specs need anyway.
 */
export async function demoTaxpayer(): Promise<{ taxpayerId: number; tin: string }> {
  const me = await apiGet<{ taxpayerId: number; tin: string }>('acme-finance', '/portal/me');
  return { taxpayerId: me.taxpayerId, tin: me.tin };
}

/**
 * An assessment year this taxpayer has not used.
 *
 * The register enforces one live case per taxpayer, tax type and year, so a
 * hard-coded year passes once and then fails with a 409 that reads like a
 * defect. A clock-derived one only moves the problem: two runs a minute apart
 * collided in practice.
 *
 * So the suite asks what is already there and takes the first free year. It
 * costs one request and makes the run repeatable, which matters more for a
 * suite people are meant to run before pushing.
 */
export async function freeAssessmentYear(taxpayerTin = '1234567890'): Promise<string> {
  // Every page, not the first one. This used to read `/cases?pageSize=200`
  // and treat it as the whole register, which is true until the suite has run
  // often enough to fill a second page. After that it started handing back a
  // year an unseen case already held, the server refused the duplicate, and
  // the run failed at "open a case" looking like a defect in the workbench.
  const used = new Set<string>();

  for (let page = 1; ; page += 1) {
    const result = await apiGet<{
      rows: { tin: string; assessmentYear: string }[];
      total: number;
    }>('supervisor', `/cases?search=${encodeURIComponent(taxpayerTin)}&pageSize=200&page=${page}`);

    for (const row of result.rows) {
      if (row.tin === taxpayerTin) used.add(String(row.assessmentYear));
    }

    if (result.rows.length < 200 || page * 200 >= result.total) break;
  }

  // Past the highest year the suite has ever reached. A closed year is legal
  // to reopen now, but taking one would make a run's cases share a period
  // with an earlier run's, so the search stays forward-only.
  for (let year = 2100; year < 3600; year += 1) {
    if (!used.has(String(year))) {
      return String(year);
    }
  }

  throw new Error('No free assessment year left; clean the test cases out of the register.');
}

export const test = base.extend<{
  /** A page signed in as the given role, closed when the test ends. */
  as: (role: Role) => Promise<Page>;
}>({
  as: async ({ browser }, use) => {
    const opened: Page[] = [];

    await use(async (role: Role) => {
      const page = await openAs(browser, role);
      opened.push(page);
      return page;
    });

    for (const page of opened) {
      await page.context().close();
    }
  },
});

export { expect } from '@playwright/test';

// Re-exported so a spec has one import rather than two.
export { ROLES, OFFICERS, NAVIGATION, PASSWORD } from './session';
export type { Role } from './session';
