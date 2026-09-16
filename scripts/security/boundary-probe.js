#!/usr/bin/env node
/**
 * Probes the authorisation boundary of a running deployment.
 *
 * Plan reference: V2 sections 19.2, 27.3.
 *
 * ## What this is
 *
 * The checks a penetration tester runs first, automated so they run every
 * time rather than once per engagement: can a taxpayer read another
 * taxpayer's assessment, can an officer reach an endpoint their role does not
 * hold, does an unauthenticated request get anywhere, are the rate limits real.
 *
 * ## What this is not
 *
 * A penetration test. A real engagement brings creativity this script has
 * none of: chained weaknesses, timing, token manipulation, the infrastructure
 * around the application. Passing every check here means the obvious doors are
 * shut, not that the building is secure.
 *
 * ## Why it is safe to run
 *
 * Every probe is a read or a deliberately-refused write. Nothing here creates
 * or modifies a case. It does consume rate-limit budget, which is the point of
 * the last section.
 *
 * Usage:
 *   node scripts/security/boundary-probe.js
 *   node scripts/security/boundary-probe.js --api http://localhost:3000
 */

const API = argValue('api', 'http://localhost:3000') + '/api/v1';
const KEYCLOAK =
  argValue('keycloak', 'http://localhost:8085') +
  '/realms/tax-assessment/protocol/openid-connect/token';

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const results = [];
function record(area, description, passed, detail) {
  results.push({ area, description, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${description}${detail ? `  (${detail})` : ''}`);
}

async function token(username) {
  const response = await fetch(KEYCLOAK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'tas-web',
      username,
      password: 'password',
      grant_type: 'password',
    }),
  });
  if (!response.ok) return null;
  return (await response.json()).access_token;
}

async function status(path, accessToken, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  return response.status;
}

async function body(path, accessToken) {
  const response = await fetch(`${API}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Probing ${API}\n`);

  // ---------------------------------------------------------- unauthenticated
  console.log('Unauthenticated access');
  for (const path of [
    '/cases',
    '/reports/assessment-summary',
    '/admin/permissions',
    '/portal/me',
  ]) {
    const code = await status(path, null);
    record(
      'anonymous',
      `${path} refuses an anonymous caller`,
      code === 401 || code === 403,
      `HTTP ${code}`,
    );
  }

  // A forged token must not be accepted. The signature is what stops somebody
  // minting themselves an admin claim.
  const forged =
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        preferred_username: 'attacker',
        realm_access: { roles: ['TA_ADMIN'] },
      }),
    ).toString('base64url') +
    '.';
  const forgedCode = await status('/cases', forged);
  record('anonymous', 'an unsigned token is refused', forgedCode === 401, `HTTP ${forgedCode}`);

  // ------------------------------------------------------------- the taxpayer
  console.log('\nTaxpayer boundary');
  const taxpayer = await token('acme-finance');
  if (taxpayer === null) {
    record('portal', 'a taxpayer login exists', false, 'could not obtain a token');
  } else {
    const me = await body('/portal/me', taxpayer);
    const ownTaxpayerId = me?.taxpayerId;
    record(
      'portal',
      'the portal resolves the caller to one taxpayer',
      Number.isInteger(ownTaxpayerId),
      `taxpayer ${ownTaxpayerId}`,
    );

    // Officer surfaces must be closed to a taxpayer, whatever they know.
    for (const path of [
      '/cases',
      '/disputes',
      '/reports/assessment-summary',
      '/reports/reconciliation',
      '/admin/permissions',
      '/selection/runs',
      '/rule-sets',
      '/notice-templates',
      '/dashboard/summary',
      '/dashboard/workload',
      '/exports',
    ]) {
      const code = await status(path, taxpayer);
      record('portal', `a taxpayer cannot reach ${path}`, code === 403, `HTTP ${code}`);
    }

    // The one that matters most: another taxpayer's data, by identifier.
    const ownCases = (await body('/portal/cases', taxpayer)) ?? [];
    const ownIds = new Set(ownCases.map((row) => Number(row.id)));

    let leaked = 0;
    let probed = 0;
    for (let caseId = 1; caseId <= 12; caseId += 1) {
      if (ownIds.has(caseId)) continue;
      probed += 1;

      const detail = await body(`/portal/cases/${caseId}`, taxpayer);
      if (detail && detail.case_number) leaked += 1;

      for (const suffix of ['notices', 'objections']) {
        const rows = await body(`/portal/cases/${caseId}/${suffix}`, taxpayer);
        if (Array.isArray(rows) && rows.length > 0) leaked += 1;
      }
    }
    record(
      'portal',
      'no other taxpayer data is reachable by guessing a case id',
      leaked === 0,
      `${probed} foreign case ids probed, ${leaked} disclosures`,
    );

    // A taxpayer must not be able to move their own case along.
    const transition = await status('/cases/2/transition', taxpayer, {
      method: 'POST',
      body: JSON.stringify({ action: 'APPROVE' }),
    });
    record(
      'portal',
      'a taxpayer cannot transition a case',
      transition === 403,
      `HTTP ${transition}`,
    );
  }

  // ----------------------------------------------------------- officer roles
  console.log('\nOfficer separation');
  const assessor = await token('assessor');
  const objectionOfficer = await token('objection-officer');

  if (assessor !== null) {
    for (const path of ['/admin/permissions', '/reports/reconciliation', '/selection/runs']) {
      const code = await status(path, assessor);
      record('officer', `an assessor cannot reach ${path}`, code === 403, `HTTP ${code}`);
    }
  }

  if (objectionOfficer !== null) {
    // The objection officer decides objections; opening cases is not theirs.
    const code = await status('/cases', objectionOfficer, {
      method: 'POST',
      body: JSON.stringify({
        taxpayerId: 1,
        taxTypeCode: 'CIT',
        assessmentYear: '2099',
        assessmentType: 'DESK',
        triggerPath: 'RISK',
      }),
    });
    record('officer', 'an objection officer cannot open a case', code === 403, `HTTP ${code}`);
  }

  // --------------------------------------------------------------- injection
  console.log('\nInput handling');
  if (assessor !== null) {
    // Parameterised queries throughout, so this should be a 404 or a 400 and
    // never a 500 with a database message.
    const injected = await status(
      `/cases/${encodeURIComponent('1; DROP TABLE tax.tax_assessment_case;--')}`,
      assessor,
    );
    record(
      'input',
      'a SQL metacharacter in a path parameter is handled',
      injected !== 500,
      `HTTP ${injected}`,
    );

    const stillThere = await status('/cases?pageSize=1', assessor);
    record('input', 'the register survived the attempt', stillThere === 200, `HTTP ${stillThere}`);

    // Mass assignment: the DTOs use forbidNonWhitelisted.
    const extra = await status('/cases/2/adjustments', assessor, {
      method: 'POST',
      body: JSON.stringify({
        adjustmentType: 'X',
        reasonCode: 'Y',
        amount: '1.00',
        direction: 'ADD',
        status: 'APPROVED',
      }),
    });
    record(
      'input',
      'an unexpected field is rejected rather than bound',
      extra === 400,
      `HTTP ${extra}`,
    );

    // A JSON number where money is expected.
    const floated = await status('/cases/2/adjustments', assessor, {
      method: 'POST',
      body: JSON.stringify({
        adjustmentType: 'X',
        reasonCode: 'Y',
        amount: 1.005,
        direction: 'ADD',
      }),
    });
    record(
      'input',
      'a JSON number is refused where money is expected',
      floated === 400,
      `HTTP ${floated}`,
    );
  }

  // -------------------------------------------------------- security headers
  console.log('\nResponse headers');
  if (assessor !== null) {
    const response = await fetch(`${API}/cases?pageSize=1`, {
      headers: { Authorization: `Bearer ${assessor}` },
    });
    const policy = response.headers.get('content-security-policy') ?? '';
    record(
      'headers',
      'a content security policy is set',
      policy.includes("default-src 'none'"),
      policy || 'absent',
    );
    record('headers', 'the API cannot be framed', policy.includes("frame-ancestors 'none'"));
    record(
      'headers',
      'content types are not sniffed',
      response.headers.get('x-content-type-options') === 'nosniff',
    );
    // A JSON API has no business advertising the framework it runs on.
    record(
      'headers',
      'the framework is not advertised',
      response.headers.get('x-powered-by') === null,
      response.headers.get('x-powered-by') ?? 'absent',
    );
  }

  // ----------------------------------------------------------------- exports
  console.log('\nExports');
  if (assessor !== null && objectionOfficer !== null) {
    // An export is the cheapest way to take a copy of the whole register, so
    // the two properties that matter are that it carries the requester's
    // scope and that only the requester can collect it.
    const requested = await fetch(`${API}/exports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${assessor}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gridKey: 'ASSESSMENT_REGISTER', format: 'CSV', filters: {} }),
    });
    const job = requested.ok ? await requested.json() : null;
    record(
      'export',
      'an officer may export their own register',
      requested.ok,
      `HTTP ${requested.status}`,
    );

    if (job !== null) {
      const byAnother = await status(`/exports/${job.uuid}/download`, objectionOfficer);
      record('export', 'another officer cannot collect it', byAnother === 404, `HTTP ${byAnother}`);

      if (taxpayer !== null) {
        const byTaxpayer = await status(`/exports/${job.uuid}/download`, taxpayer);
        record('export', 'a taxpayer cannot collect it', byTaxpayer === 403, `HTTP ${byTaxpayer}`);
      }
    }

    // A grid key names a published register, not a table.
    const unknownGrid = await status('/exports', assessor, {
      method: 'POST',
      body: JSON.stringify({ gridKey: 'PLATFORM_APP_USER', format: 'CSV', filters: {} }),
    });
    record(
      'export',
      'an unpublished register cannot be exported',
      unknownGrid === 400 || unknownGrid === 404,
      `HTTP ${unknownGrid}`,
    );
  }

  // ------------------------------------------------------------- register sort
  console.log('\nRegister sort');
  if (assessor !== null) {
    // `sort` is the closest a caller gets to writing an ORDER BY. It names a
    // column key, which is resolved against an allowlist, so none of these
    // reach SQL in any form.
    for (const attempt of [
      'c.case_number; DROP TABLE tax.tax_assessment_case;--',
      '(SELECT 1)',
      "case_number' OR '1'='1",
    ]) {
      const code = await status(`/cases?sort=${encodeURIComponent(attempt)}`, assessor);
      record('input', `sort "${attempt.slice(0, 24)}" is refused`, code === 400, `HTTP ${code}`);
    }
    const survived = await status('/cases?pageSize=1', assessor);
    record(
      'input',
      'the register survived the sort attempts',
      survived === 200,
      `HTTP ${survived}`,
    );
  }

  // --------------------------------------------------- public notice checking
  console.log('\nPublic notice verification');
  {
    // The one route open to the world. It must answer without a token, and it
    // must answer with nothing beyond whether the notice is genuine.
    const anonymous = await fetch(
      `${API}/public/notices/00000000-0000-4000-8000-000000000000/verify`,
    );
    const body = anonymous.ok ? await anonymous.json() : {};
    record(
      'public',
      'verification is reachable without a token',
      anonymous.status === 200,
      `HTTP ${anonymous.status}`,
    );
    record(
      'public',
      'it discloses no financial detail',
      !('amount' in body) &&
        !('caseId' in body) &&
        !('taxpayer' in body) &&
        !('storedHash' in body),
      Object.keys(body).join(', ') || 'empty',
    );
    const malformed = await fetch(`${API}/public/notices/not-a-reference/verify`);
    record(
      'public',
      'a malformed reference does not reach the database',
      malformed.status === 400,
      `HTTP ${malformed.status}`,
    );
  }

  // -------------------------------------------------------------- rate limit
  console.log('\nRate limiting');
  if (taxpayer !== null) {
    let limited = false;
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const code = await status(
        '/portal/notices/00000000-0000-0000-0000-000000000000/document',
        taxpayer,
      );
      if (code === 429) {
        limited = true;
        record('rate', 'the portal download limit is enforced', true, `429 at attempt ${attempt}`);
        break;
      }
    }
    if (!limited)
      record('rate', 'the portal download limit is enforced', false, 'no 429 in 25 attempts');
  }

  // The public route has no account behind it, so its limit is the only thing
  // between a reference space and somebody enumerating it.
  {
    let limited = false;
    for (let attempt = 1; attempt <= 45; attempt += 1) {
      const response = await fetch(
        `${API}/public/notices/00000000-0000-4000-8000-00000000000${attempt % 10}/verify`,
      );
      if (response.status === 429) {
        limited = true;
        record(
          'rate',
          'the public verification limit is enforced',
          true,
          `429 at attempt ${attempt}`,
        );
        break;
      }
    }
    if (!limited) {
      record('rate', 'the public verification limit is enforced', false, 'no 429 in 45 attempts');
    }
  }

  // ------------------------------------------------------------------ report
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const failure of failed) {
      console.log(`  ${failure.area}: ${failure.description} (${failure.detail})`);
    }
    process.exit(1);
  }
  console.log('The obvious doors are shut. This is not a substitute for a penetration test.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
