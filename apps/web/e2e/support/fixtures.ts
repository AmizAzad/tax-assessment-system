import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
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
 * suite take longer than it is worth. The saved session is in place before
 * the app boots, so it is restored exactly as it would be for a returning
 * user; a login performed after load would test a different path from the
 * one a person takes.
 */

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

/**
 * A write the server is expected to refuse, and what it said.
 *
 * The screen no longer offers an action a role cannot take, so a refusal the
 * suite used to provoke by clicking is now asserted here. Both halves are
 * the control: the screen not inviting the shortcut, and the server refusing
 * it for anyone who tries anyway.
 */
export async function apiAttempt(
  role: Role,
  path: string,
  body: unknown,
): Promise<{ status: number; message: string }> {
  const token = await apiToken(role);
  const response = await fetch(`${API}/api/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
  const message = Array.isArray(payload.message)
    ? payload.message.join(' ')
    : String(payload.message ?? '');
  return { status: response.status, message };
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

/**
 * The configured `video` mode, applied to the context this suite opens itself.
 *
 * Playwright records only the context behind its own `page` fixture. The
 * stage below is a context of its own, so without this the setting in the
 * config recorded the sign-in and nothing after it.
 */
function videoMode(testInfo: TestInfo): string {
  const video = testInfo.project.use.video;
  return (typeof video === 'object' ? video.mode : video) ?? 'off';
}

function keepVideo(mode: string, testInfo: TestInfo): boolean {
  const failed = testInfo.status !== testInfo.expectedStatus;
  if (mode === 'on') return true;
  if (mode === 'retain-on-failure') return failed;
  if (mode === 'on-first-retry') return testInfo.retry === 1;
  return false;
}

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:4200';

/**
 * Each officer's latest session, carried between hand-overs and tests.
 *
 * Seeded from the files the sign-in setup wrote. Those age: access tokens
 * last fifteen minutes, and a run that reached the full cycle after that
 * handed the tab over with an expired token, so the app sent the officer to
 * the login page in the middle of a step.
 */
const sessions = new Map<Role, string>();

/** When the oidc user in a stored session stops being accepted, in ms. */
function liveUntil(stored: string): number {
  const entries = JSON.parse(stored) as Record<string, string>;
  const key = Object.keys(entries).find((k) => k.startsWith('oidc.user:'));
  if (key === undefined) return 0;
  const user = JSON.parse(entries[key]!) as { expires_at?: number };
  return (user.expires_at ?? 0) * 1000;
}

/**
 * A session for `role` that will outlast the next step.
 *
 * Refreshed at Keycloak with the session's own refresh token when it is
 * about to expire — what the app itself does silently while it runs. Null
 * when even the refresh token has lapsed, and only the login form will do.
 */
async function freshSession(role: Role): Promise<string | null> {
  const stored = sessions.get(role) ?? readFileSync(sessionFile(role), 'utf8');
  if (liveUntil(stored) > Date.now() + 120_000) return stored;

  const entries = JSON.parse(stored) as Record<string, string>;
  const key = Object.keys(entries).find((k) => k.startsWith('oidc.user:'));
  if (key === undefined) return null;
  const user = JSON.parse(entries[key]!) as Record<string, unknown>;
  if (typeof user['refresh_token'] !== 'string') return null;

  const response = await fetch(`${KEYCLOAK}/realms/tax-assessment/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'tas-web',
      grant_type: 'refresh_token',
      refresh_token: user['refresh_token'],
    }),
  });
  if (!response.ok) return null;
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  const renewed = {
    ...user,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? user['refresh_token'],
    id_token: tokens.id_token ?? user['id_token'],
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
  };
  const session = JSON.stringify({ ...entries, [key]: JSON.stringify(renewed) });
  sessions.set(role, session);
  return session;
}

/** How long the hand-over card stays up in a recording, so a viewer can read it. */
const HANDOVER_PAUSE_MS = 1_500;

/**
 * Who is acting, drawn over every page of a recording.
 *
 * In a closed shadow root so no locator in any spec can match it: a
 * `getByText('reviewer')` that found the caption instead of the screen would
 * pass on a screen that shows nothing.
 */
function drawCaption(): void {
  const draw = (): void => {
    if (document.getElementById('tas-e2e-caption') !== null || document.body === null) return;
    let who = '';
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index) ?? '';
      if (!key.startsWith('oidc.user:')) continue;
      try {
        who = JSON.parse(sessionStorage.getItem(key) ?? '{}').profile?.preferred_username ?? '';
      } catch {
        who = '';
      }
    }
    if (who === '') return;
    const host = document.createElement('div');
    host.id = 'tas-e2e-caption';
    host.setAttribute('aria-hidden', 'true');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<div style="position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;' +
      'font:600 14px/1.2 system-ui,sans-serif;padding:6px 12px;border-radius:999px;' +
      `background:rgba(17,24,39,.85);color:#fff">Acting as ${who}</div>`;
    document.body.appendChild(host);
  };
  document.addEventListener('DOMContentLoaded', draw);
  new MutationObserver(draw).observe(document, { childList: true, subtree: true });
}

/**
 * One browser tab for the whole test, handed to each officer in turn.
 *
 * A lifecycle is several people acting on one case in order, and the
 * recording has to show it as one sequence a person can follow. A context per
 * officer produced a video per officer, each mostly idle while the others
 * worked.
 *
 * Each officer still acts on their own session: the tab is emptied of the
 * last officer's sessionStorage and given the next one's before the app boots,
 * so the API sees a different token exactly as it would from a different
 * desk. The swap happens on `/favicon.ico` because the app is not running
 * there, and so nothing can write the previous officer's session back.
 */
class Stage {
  private current: Role | null = null;

  constructor(
    readonly page: Page,
    private readonly recording: boolean,
  ) {}

  get role(): Role | null {
    return this.current;
  }

  async signInAs(role: Role): Promise<void> {
    await this.keepCurrentSession();
    const session = await freshSession(role);
    await this.page.goto('/favicon.ico');
    if (session === null) {
      await this.signInThroughTheForm(role);
      return;
    }
    // Written into the icon's document rather than with setContent(), which
    // waits for a load event an image document never fires a second time.
    await this.page.evaluate(
      ({ stored, who, card }: { stored: string; who: string; card: boolean }) => {
        window.sessionStorage.clear();
        for (const [key, value] of Object.entries(JSON.parse(stored) as Record<string, string>)) {
          window.sessionStorage.setItem(key, value);
        }
        if (card) {
          document.body.setAttribute(
            'style',
            'margin:0;display:grid;place-items:center;height:100vh;' +
              'font:600 28px system-ui,sans-serif;background:#1f3a5f;color:#fff',
          );
          document.body.textContent = `Signing in as ${who}`;
        }
      },
      { stored: session, who: role, card: this.recording },
    );
    this.current = role;
    if (this.recording) {
      // Pacing for the viewer, not a wait on the application.
      await this.page.waitForTimeout(HANDOVER_PAUSE_MS);
    }
  }

  /**
   * Take the outgoing officer's session with them.
   *
   * The app renews its token silently while it runs, so the storage it leaves
   * behind is newer than anything saved at setup. Only a live session is
   * kept: a tab that has already bounced to the login page holds nothing
   * worth reusing.
   */
  private async keepCurrentSession(): Promise<void> {
    if (this.current === null || !this.page.url().startsWith(new URL('/', BASE_URL).href)) return;
    const stored = await this.page
      .evaluate(() => JSON.stringify(window.sessionStorage))
      .catch(() => null);
    if (stored !== null && liveUntil(stored) > Date.now()) {
      sessions.set(this.current, stored);
    }
  }

  /** The real login form, for a session too old even to refresh. */
  private async signInThroughTheForm(role: Role): Promise<void> {
    await this.page.evaluate(() => window.sessionStorage.clear());
    await this.page.goto('/');
    await this.page.locator('#username').fill(role);
    await this.page.locator('#password').fill(PASSWORD);
    await this.page.locator('#kc-login').click();
    await expect(this.page.locator('.tas-shell__whoami')).toContainText(role, {
      timeout: 30_000,
    });
    this.current = role;
    await this.keepCurrentSession();
  }

  /** Navigate as `role`, and prove the shell agrees about who that is. */
  async arrive(role: Role, url: string): Promise<void> {
    await this.page.goto(url);
    await expect(this.page.locator('.tas-shell__whoami')).toContainText(role, {
      timeout: 30_000,
    });
  }
}

/** Page members that are safe to read whoever holds the tab. */
const INERT = new Set([
  'then',
  'constructor',
  'url',
  'video',
  'isClosed',
  'context',
  'viewportSize',
]);
/** Page members that move the tab, and so may hand it over first. */
const NAVIGATIONS = new Set(['goto', 'reload']);

/**
 * The page as one officer sees it.
 *
 * Navigating through it hands the tab to that officer if somebody else holds
 * it. Anything else while somebody else holds it is refused rather than
 * performed: a click that silently landed as the wrong officer would turn a
 * segregation-of-duties check into a test of the other role.
 */
function officerView(stage: Stage, role: Role): Page {
  return new Proxy(stage.page, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof property !== 'string' || INERT.has(property)) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (NAVIGATIONS.has(property)) {
        return async (...args: unknown[]) => {
          if (stage.role !== role) {
            await stage.signInAs(role);
            if (property === 'goto') {
              return stage.arrive(role, String(args[0]));
            }
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (stage.role !== role) {
        throw new Error(
          `The ${role} page was used while ${stage.role ?? 'nobody'} holds the tab. ` +
            'Navigate it first (page.goto), so the hand-over is part of the run.',
        );
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const test = base.extend<{
  /** The shared tab, signed in as the given role, closed when the test ends. */
  as: (role: Role) => Promise<Page>;
}>({
  as: async ({ browser }, use, testInfo) => {
    const mode = videoMode(testInfo);
    const recording = mode !== 'off';
    const viewport = testInfo.project.use.viewport ?? { width: 1440, height: 900 };
    const views = new Map<Role, Page>();
    let stage: Stage | undefined;

    await use(async (role: Role) => {
      if (stage === undefined) {
        const context = await browser.newContext({
          viewport,
          ...(recording
            ? { recordVideo: { dir: testInfo.outputPath('videos'), size: viewport } }
            : {}),
        });
        if (recording) {
          await context.addInitScript(drawCaption);
        }
        stage = new Stage(await context.newPage(), recording);
      }
      await stage.signInAs(role);
      await stage.arrive(role, '/');

      let view = views.get(role);
      if (view === undefined) {
        view = officerView(stage, role);
        views.set(role, view);
      }
      return view;
    });

    if (stage === undefined) return;
    const page = stage.page;
    await page.context().close();

    const path = await page.video()?.path();
    if (path === undefined) return;
    if (keepVideo(mode, testInfo)) {
      // attach() copies into the test's attachments, so the original would
      // otherwise sit beside it as an unnamed duplicate.
      await testInfo.attach('video', { path, contentType: 'video/webm' });
    }
    rmSync(path, { force: true });
  },
});

export { expect } from '@playwright/test';

// Re-exported so a spec has one import rather than two.
export { ROLES, OFFICERS, NAVIGATION, PASSWORD } from './session';
export type { Role } from './session';
