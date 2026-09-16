#!/usr/bin/env node
/**
 * Fill the register with synthetic cases, to prove it holds at scale.
 *
 * Plan reference: V2 section 27.2 and the Phase 2 note that the register is
 * load-tested "now, not in Phase 8".
 *
 * ## Why this exists
 *
 * Every index in this system was chosen by reasoning about the queries, which
 * is the right way to start and no substitute for measuring. A register with
 * five cases in it answers every query instantly whether or not the indexes
 * are any good.
 *
 * ## Why it writes SQL directly rather than calling the API
 *
 * A million cases through the HTTP layer would take hours and would mostly
 * measure Node, not Postgres. The point here is to give the *database*
 * something to work with; the API is then measured separately against it with
 * `k6-register.js`.
 *
 * The trade-off is stated plainly: these rows bypass the case service, so they
 * have no ledger events, no participation records and no calculations unless
 * asked for. They are ballast for the indexes, not valid assessments, and this
 * script refuses to run against a database that is not obviously a test one.
 *
 * ## The taxpayer pool has to be large enough
 *
 * A live case is unique per taxpayer, tax type and year, enforced by a partial
 * unique index. So the reachable ceiling is roughly `taxpayers x years`, and
 * asking for more cases than that simply collides: the first run of this
 * script asked for 200,000 against 20,000 taxpayers and got 140,004, which is
 * exactly 20,000 x 7. The script now says so rather than leaving somebody to
 * wonder where the rows went.
 *
 * Usage:
 *   node scripts/load/seed-register.js --cases 1000000 --taxpayers 200000
 *   node scripts/load/seed-register.js --clean
 *
 * ## Measured
 *
 * At 920,003 cases on a laptop container, through the full API including
 * authentication and the permission check:
 *
 * | Endpoint | Total |
 * |---|---|
 * | `GET /cases?pageSize=25` | 244 ms |
 * | `GET /cases?status=UNDER_REVIEW` | 42 ms |
 * | `GET /reports/assessment-summary` | 274 ms |
 * | `GET /reports/ageing` | 433 ms |
 * | `GET /reports/deadline-exposure` | 34 ms |
 *
 * The database accounts for 80-100 ms of the slowest two; both are parallel
 * aggregates over the whole register, which is inherent to an unfiltered count.
 * A filtered register page is the common case and stays comfortably under
 * 50 ms.
 */

const { Client } = require('pg');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const TOTAL = Number(arg('cases', '100000'));
const BATCH = Number(arg('batch', '5000'));
const TAXPAYERS = Number(arg('taxpayers', '50000'));

const STATUSES = [
  'INITIATED',
  'DATA_READY',
  'ASSIGNED',
  'IN_PREPARATION',
  'CALCULATED',
  'UNDER_REVIEW',
  'REVIEWED',
  'PENDING_APPROVAL',
  'APPROVED',
  'FINALISED',
  'NOTICE_SERVED',
  'AWAITING_TAXPAYER_RESPONSE',
  'SETTLED',
  'CLOSED',
];

async function main() {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? 'tas',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'tax_assessment',
  });
  await client.connect();

  /**
   * Refuse to fill a database that might be real.
   *
   * A million synthetic taxpayers in a production register would be a data
   * incident, and the only thing standing between this script and that is a
   * check it makes itself.
   */
  const { rows: guard } = await client.query(
    `SELECT current_database() AS name, count(*)::int AS real_cases
       FROM tax.tax_assessment_case WHERE assessment_type <> 'LOAD_TEST'`,
  );
  const database = guard[0].name;
  if (!/test|dev|local/i.test(database) && guard[0].real_cases > 1000) {
    throw new Error(
      `Refusing to seed '${database}': it holds ${guard[0].real_cases} non-synthetic cases and ` +
        'its name does not look like a test database.',
    );
  }

  if (args.includes('--clean')) {
    // Synthetic rows are identifiable by assessment_type, so cleanup can be
    // exact rather than "everything created after a timestamp".
    console.log('Removing synthetic load-test data…');
    await client.query(`DELETE FROM tax.tax_assessment_case WHERE assessment_type = 'LOAD_TEST'`);
    await client.query(`DELETE FROM platform.taxpayer WHERE tin LIKE 'LT%'`);
    await client.query('ANALYZE tax.tax_assessment_case');
    const { rows: left } = await client.query(
      `SELECT count(*)::int AS total FROM tax.tax_assessment_case`,
    );
    console.log(`Done. Register holds ${left[0].total} real case(s).`);
    await client.end();
    return;
  }

  const YEARS = 7;
  const ceiling = TAXPAYERS * YEARS;
  if (TOTAL > ceiling) {
    console.warn(
      `Note: a live case is unique per taxpayer, tax type and year, so ${TAXPAYERS} taxpayers ` +
        `over ${YEARS} years can hold at most ${ceiling} cases. Asking for ${TOTAL} will stop ` +
        `there. Raise --taxpayers to go higher.`,
    );
  }

  console.log(`Seeding ${TOTAL} cases into ${database} in batches of ${BATCH}…`);
  const started = Date.now();

  // Taxpayers first: cases reference them, and a register where every case
  // belongs to one taxpayer would make every index look better than it is.
  await client.query(`
    INSERT INTO platform.taxpayer
      (tin, name, taxpayer_kind, jurisdiction_code, status, registration_date,
       preferred_language, created_at, updated_at, is_active)
    SELECT 'LT' || lpad(g::text, 10, '0'),
           'Load Test Company ' || g,
           'COMPANY', 'GB', 'ACTIVE', '2020-01-01', 'en', now(), now(), true
      FROM generate_series(1, ${TAXPAYERS}) g
     WHERE NOT EXISTS (
       SELECT 1 FROM platform.taxpayer WHERE tin = 'LT' || lpad(g::text, 10, '0'))
  `);
  console.log(`  taxpayers ready (${TAXPAYERS})`);

  let written = 0;
  while (written < TOTAL) {
    const size = Math.min(BATCH, TOTAL - written);
    const offset = written;

    // Generated in the database rather than sent over the wire: a million
    // parameterised inserts from Node would measure the driver.
    await client.query(
      `INSERT INTO tax.tax_assessment_case
              (case_number, taxpayer_id, tin, taxpayer_name, tax_type_code,
               jurisdiction_code, assessment_year, assessment_type, trigger_path,
               status_code, liability_status, version, currency_code,
               opened_at, created_at, updated_at, is_active)
       SELECT 'LT' || lpad((${offset} + g)::text, 12, '0'),
              t.id, t.tin, t.name, 'CIT',
              'GB',
              (2018 + ((${offset} + g) % 7))::text,
              'LOAD_TEST',
              'RANDOM',
              ($1::text[])[1 + ((${offset} + g) % ${STATUSES.length})],
              'OPEN', 1, 'GBP',
              now() - ((${offset} + g) % 900) * INTERVAL '1 day',
              now(), now() - ((${offset} + g) % 400) * INTERVAL '1 day', true
         FROM generate_series(1, ${size}) g
         JOIN platform.taxpayer t
           ON t.tin = 'LT' || lpad((1 + ((${offset} + g) % ${TAXPAYERS}))::text, 10, '0')
       ON CONFLICT DO NOTHING`,
      [STATUSES],
    );

    written += size;
    if (written % (BATCH * 10) === 0 || written === TOTAL) {
      const rate = Math.round(written / ((Date.now() - started) / 1000));
      console.log(`  ${written}/${TOTAL} (${rate}/s)`);
    }
  }

  console.log('Analysing…');
  await client.query('ANALYZE tax.tax_assessment_case');
  await client.query('ANALYZE platform.taxpayer');

  const { rows: counts } = await client.query(
    `SELECT count(*)::int AS total FROM tax.tax_assessment_case`,
  );
  console.log(
    `Done in ${Math.round((Date.now() - started) / 1000)}s. Register holds ${counts[0].total} cases.`,
  );

  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
