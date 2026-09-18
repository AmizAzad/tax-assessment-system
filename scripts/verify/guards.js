#!/usr/bin/env node
'use strict';

/**
 * Architectural guards.
 *
 * ESLint covers the controls that are visible in one file's syntax: monetary
 * arithmetic, `Math.round`, module boundaries. These three are not — each one
 * is about which files in the repository are allowed to do a thing at all, or
 * about the shape of a SQL string that no rule reads.
 *
 *   1. money-boundaries  — ADR-007. `decimal.js` and the two `unsafe*` escape
 *                          hatches are confined to named files.
 *   2. audit-append-only — ADR-009, ADR-013. The event ledger is never mutated
 *                          and the triggers that enforce it are never dropped.
 *   3. sql-interpolation — ADR-016. Configuration and callers name a key; they
 *                          never contribute text to a query.
 *
 * Run `node scripts/verify/guards.js --self-test` to watch each guard fire
 * against a known violation. A control nobody has watched fail is not a
 * control — the same standard `.eslintrc.js` sets for its own rules.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const SCANNED_ROOTS = ['apps/api/src', 'apps/worker/src', 'apps/web/src', 'packages', 'db'];

const SKIPPED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out-tsc',
  '.angular',
  'target',
]);

// ---------------------------------------------------------------- guard 1

/**
 * `decimal.js` is an implementation detail of @tas/decimal. A second copy of
 * the raw library anywhere else is a second rounding policy.
 */
const DECIMAL_IMPORT = /from\s+['"]decimal\.js['"]/;

/**
 * Both hatches are named `unsafe` because every call is a place precision can
 * already have been lost. They are allowed only where the loss happened before
 * we were called, and each entry here carries the reason.
 */
const UNSAFE_MONEY_ALLOWLIST = new Map([
  ['packages/decimal/src/money.ts', 'defines them'],
  ['packages/decimal/test/money.spec.ts', 'tests them'],
  [
    'apps/api/src/tax-assessment/evidence/filing.provider.ts',
    'filing payloads arrive as JSON numbers; the loss predates this boundary',
  ],
]);

const UNSAFE_MONEY = /\bunsafe(FromNumber|ToNumber)\b/;

function moneyBoundaries(files) {
  const violations = [];

  for (const file of files) {
    if (!file.relative.startsWith('packages/decimal/') && DECIMAL_IMPORT.test(file.text)) {
      violations.push({
        file: file.relative,
        line: lineOf(file.text, DECIMAL_IMPORT),
        message: "imports 'decimal.js' directly. Use the Money type from @tas/decimal (ADR-007)",
      });
    }

    if (UNSAFE_MONEY.test(file.text) && !UNSAFE_MONEY_ALLOWLIST.has(file.relative)) {
      violations.push({
        file: file.relative,
        line: lineOf(file.text, UNSAFE_MONEY),
        message:
          'calls a Money unsafe* escape hatch. Carry the value as a string, or add this file to ' +
          'UNSAFE_MONEY_ALLOWLIST in scripts/verify/guards.js with the reason (ADR-007)',
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------- guard 2

const APPEND_ONLY_MIGRATION = 'db/migrations/20261010000100-append-only-audit.js';

const PROTECTED_TABLES = ['tax_assessment_event', 'tax_assessment_evidence'];

const APPEND_ONLY_TRIGGERS = [
  'trg_event_append_only',
  'trg_evidence_no_delete',
  'trg_evidence_no_rewrite',
];

/**
 * One UPDATE is legal, and only one: evidence is superseded by moving
 * `is_current`, which is exactly what `tax.refuse_evidence_rewrite()` permits.
 * Anything else that mutates either table contradicts a database trigger, so it
 * would fail at runtime anyway — this guard makes it fail in review instead.
 */
function auditAppendOnly(files) {
  const violations = [];

  for (const file of files) {
    if (file.relative === APPEND_ONLY_MIGRATION) continue;

    for (const statement of sqlStatements(file.text)) {
      const operation = /^\s*(UPDATE|DELETE\s+FROM|TRUNCATE)\b/i.exec(statement.text);
      if (!operation) continue;

      const table = PROTECTED_TABLES.find((name) =>
        new RegExp(`\\b(tax\\.)?${name}\\b`, 'i').test(statement.text.slice(0, 200)),
      );
      if (!table) continue;

      const isLegalSupersede =
        table === 'tax_assessment_evidence' &&
        /^\s*UPDATE\b/i.test(statement.text) &&
        /\bSET\s+is_current\s*=/i.test(statement.text) &&
        !/\bSET\s+is_current\s*=[^,]*,/i.test(statement.text);

      if (isLegalSupersede) continue;

      violations.push({
        file: file.relative,
        line: lineAt(file.text, statement.index),
        message: `mutates ${table}, which is append-only and trigger-protected (ADR-009, ADR-013)`,
      });
    }

    for (const trigger of APPEND_ONLY_TRIGGERS) {
      if (new RegExp(`DROP\\s+TRIGGER[^;\`]*${trigger}`, 'i').test(file.text)) {
        violations.push({
          file: file.relative,
          line: lineOf(file.text, new RegExp(trigger)),
          message: `drops ${trigger}. The append-only control may not be removed (ADR-013)`,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------- guard 3

const SQL_SHAPED = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|ORDER\s+BY|GROUP\s+BY)\b/i;

/**
 * Every fragment that may be interpolated into a query, and where it lives.
 *
 * ADR-016 inverts who decides: configuration and callers name a key, and code
 * maps the key to SQL. That makes interpolation itself legitimate — the
 * register's ORDER BY is built exactly this way — so a guard that banned `${}`
 * outright would be wrong, and would be deleted the first time it blocked the
 * feature it was protecting.
 *
 * What is guarded instead is the *set*: these fragments are produced by code
 * that owns an allowlist, and a new one may not appear without a reviewer
 * adding it here. This is a registry, not taint analysis; it catches the open
 * door (`${query.sort}` reaching SQL directly), not a producer that is itself
 * written to be unsafe.
 */
const SQL_FRAGMENT_REGISTRY = new Map([
  [
    'apps/api/src/tax-assessment/case/register.source.ts',
    ['this.projection()', 'where', 'this.orderBy(query.sort)'],
  ],
  ['apps/api/src/tax-assessment/dashboard/dashboard.service.ts', ['scope']],
  ['apps/api/src/tax-assessment/reporting/reporting.service.ts', ['this.scopeClause()']],
]);

const INTERPOLATION = /\$\{([^}]*)\}/g;

function sqlInterpolation(files) {
  const violations = [];

  // Migrations and seeds are authored SQL, reviewed as SQL, and take nothing
  // from a caller. The control is about the request path.
  const inScope = files.filter((file) => file.relative.startsWith('apps/'));

  for (const file of inScope) {
    const registered = SQL_FRAGMENT_REGISTRY.get(file.relative) ?? [];

    for (const statement of sqlStatements(file.text)) {
      if (!SQL_SHAPED.test(statement.text)) continue;

      for (const expression of statement.text.matchAll(INTERPOLATION)) {
        const fragment = expression[1].trim();
        if (registered.includes(fragment)) continue;

        violations.push({
          file: file.relative,
          line: lineAt(file.text, statement.index),
          message:
            `interpolates \`${fragment}\` into SQL. Map caller and configuration values through a ` +
            'fixed allowlist, then register the fragment in SQL_FRAGMENT_REGISTRY in ' +
            'scripts/verify/guards.js (ADR-016)',
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------- plumbing

/** Every backtick template literal in a source file, with where it starts. */
function sqlStatements(text) {
  const found = [];
  const pattern = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ text: match[1], index: match.index });
  }
  return found;
}

/** 1-indexed line containing a character offset. */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function lineOf(text, pattern) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

function collectFiles() {
  const files = [];

  for (const root of SCANNED_ROOTS) {
    const absolute = path.join(ROOT, root);
    if (!fs.existsSync(absolute)) continue;

    for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name)) continue;

      const absoluteFile = path.join(entry.parentPath ?? entry.path, entry.name);
      const relative = path.relative(ROOT, absoluteFile).split(path.sep).join('/');
      if (relative.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment))) continue;

      files.push({ relative, text: fs.readFileSync(absoluteFile, 'utf8') });
    }
  }

  return files;
}

const GUARDS = [
  { name: 'money-boundaries', adr: 'ADR-007', run: moneyBoundaries },
  { name: 'audit-append-only', adr: 'ADR-009, ADR-013', run: auditAppendOnly },
  { name: 'sql-interpolation', adr: 'ADR-016', run: sqlInterpolation },
];

// ---------------------------------------------------------------- self-test

/**
 * Each guard is shown a file that violates it and a file that does not. A
 * guard that cannot fail is not enforcing anything, and a guard that fires on
 * the legal case would be deleted by the first person it blocked.
 */
const SELF_TEST_CASES = [
  {
    guard: 'money-boundaries',
    violating: { relative: 'apps/api/src/thing.ts', text: "import Decimal from 'decimal.js';" },
    legal: { relative: 'apps/api/src/thing.ts', text: "import { Money } from '@tas/decimal';" },
  },
  {
    guard: 'money-boundaries',
    violating: {
      relative: 'apps/api/src/thing.ts',
      text: 'const n = total.unsafeToNumber();',
    },
    legal: {
      relative: 'apps/api/src/tax-assessment/evidence/filing.provider.ts',
      text: 'const m = Money.unsafeFromNumber(raw, currency);',
    },
  },
  {
    guard: 'audit-append-only',
    violating: {
      relative: 'apps/api/src/thing.ts',
      text: 'await q(`DELETE FROM tax.tax_assessment_event WHERE id = :id`);',
    },
    legal: {
      relative: 'apps/api/src/thing.ts',
      text: 'await q(`UPDATE tax.tax_assessment_evidence SET is_current = false WHERE id = :id`);',
    },
  },
  {
    guard: 'audit-append-only',
    violating: {
      relative: 'db/migrations/20270101000000-oops.js',
      text: 'await q(`DROP TRIGGER trg_event_append_only ON tax.tax_assessment_event`);',
    },
    legal: {
      relative: 'db/migrations/20270101000000-fine.js',
      text: 'await q(`CREATE INDEX idx_event_case ON tax.tax_assessment_event (case_id)`);',
    },
  },
  {
    guard: 'sql-interpolation',
    violating: {
      relative: 'apps/api/src/thing.ts',
      text: 'await q(`SELECT * FROM tax.tax_assessment_case ORDER BY ${query.sort}`);',
    },
    legal: {
      relative: 'apps/api/src/thing.ts',
      text: 'await q(`SELECT * FROM tax.tax_assessment_case WHERE id = :id ORDER BY opened_at DESC`);',
    },
  },
  {
    // The registered fragment stays legal: the register's ORDER BY is the
    // feature ADR-016 describes, not a violation of it.
    guard: 'sql-interpolation',
    violating: {
      relative: 'apps/api/src/tax-assessment/case/register.source.ts',
      text: 'await q(`SELECT c.id FROM tax.tax_assessment_case c ORDER BY ${sort.key}`);',
    },
    legal: {
      relative: 'apps/api/src/tax-assessment/case/register.source.ts',
      text: 'await q(`SELECT c.id FROM tax.tax_assessment_case c ORDER BY ${this.orderBy(query.sort)}`);',
    },
  },
];

function selfTest() {
  let failures = 0;

  for (const [index, testCase] of SELF_TEST_CASES.entries()) {
    const guard = GUARDS.find((candidate) => candidate.name === testCase.guard);
    const caught = guard.run([testCase.violating]).length > 0;
    const quiet = guard.run([testCase.legal]).length === 0;

    if (!caught) {
      failures += 1;
      console.error(`  FAIL  case ${index + 1}: ${guard.name} did not catch its violation`);
    }
    if (!quiet) {
      failures += 1;
      console.error(`  FAIL  case ${index + 1}: ${guard.name} fired on the legal case`);
    }
    if (caught && quiet) {
      console.log(`  ok    case ${index + 1}: ${guard.name} catches and permits correctly`);
    }
  }

  if (failures > 0) {
    console.error(`\nSelf-test failed: ${failures} problem(s). The guards are not trustworthy.`);
    process.exit(1);
  }

  console.log(`\nSelf-test passed: ${SELF_TEST_CASES.length} cases.`);
}

// ---------------------------------------------------------------- entry

function main() {
  if (process.argv.includes('--self-test')) {
    console.log('Architectural guards — self-test\n');
    selfTest();
    return;
  }

  const files = collectFiles();
  let total = 0;

  for (const guard of GUARDS) {
    const violations = guard.run(files);
    total += violations.length;

    if (violations.length === 0) {
      console.log(`  ok    ${guard.name} (${guard.adr})`);
      continue;
    }

    console.error(`  FAIL  ${guard.name} (${guard.adr})`);
    for (const violation of violations) {
      console.error(`        ${violation.file}:${violation.line} ${violation.message}`);
    }
  }

  console.log(`\nScanned ${files.length} files.`);

  if (total > 0) {
    console.error(`${total} violation(s). These are architectural controls; do not silence them.`);
    process.exit(1);
  }
}

main();
