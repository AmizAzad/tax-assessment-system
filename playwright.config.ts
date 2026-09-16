import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * Plan reference: V2 section 26.1 ("E2E — multi-role journeys: initiate to
 * close, including dispute").
 *
 * ## What these tests are for, and what they are not
 *
 * Every other suite in this repository tests a part in isolation: the money
 * type, the calculation pipeline, the transition table, one API route. They
 * pass whether or not an officer can actually get a case from opened to
 * closed.
 *
 * These tests answer that question, and only that question. They drive real
 * browsers through real screens against a real API, a real Keycloak and a real
 * database, signing in as each of the nine officer roles in turn.
 *
 * They are therefore **slow, stateful and dependent on a running stack**, and
 * they are not part of `npm test`. Run them with `npm run test:e2e`.
 *
 * ## Why they are not run in CI yet
 *
 * They need Keycloak, Postgres, Redis, MinIO, the API and the web app all up.
 * CI provisions Postgres and Redis today and not the rest. The gap is stated
 * in `docs/testing.md` rather than papered over with a skipped job.
 */
export default defineConfig({
  testDir: './apps/web/e2e',

  /**
   * Serial by default.
   *
   * A case is a stateful thing moving through a lifecycle, and the roles act
   * on it in order. Parallel workers racing the same case would produce
   * failures that say nothing about the software. Individual files that are
   * genuinely independent opt back in with `test.describe.configure`.
   */
  fullyParallel: false,
  workers: 1,

  /**
   * No retries locally.
   *
   * A flaky end-to-end test that passes on the second attempt is a defect
   * report being thrown away. If one of these is unreliable, the cause is
   * worth finding.
   */
  retries: 0,
  forbidOnly: !!process.env['CI'],

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env['CI'] ? [['github'], ['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4200',
    // Kept only for failures: a trace per passing test is gigabytes nobody
    // reads, and the one that matters is the one that broke.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    // The screens are dense; a small viewport hides the action bar and makes
    // failures look like missing features.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      /**
       * Signs in once per role and saves the session.
       *
       * Every other project depends on this, so a broken login fails once and
       * loudly rather than nine times in nine tests.
       */
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],

  /**
   * The API and the web app.
   *
   * `reuseExistingServer` is deliberately on outside CI: a developer almost
   * always has both running already, and starting a second one produces the
   * port collision this project's documentation spends a section on.
   *
   * The containers are **not** started here. `npm run dev:up` is a
   * prerequisite, because bringing Postgres and Keycloak up and down around a
   * test run would destroy the data the run is working with.
   */
  webServer: [
    {
      command: 'npm run start:api',
      url: 'http://localhost:3000/health/ready',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:web',
      url: 'http://localhost:4200',
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
