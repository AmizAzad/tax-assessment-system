#!/usr/bin/env node
/**
 * Deploy the assessment process definition shipped with this release.
 *
 * Plan reference: V2 section 5.4.
 *
 * Deployment is deliberately an act and not a boot step: a definition
 * reaching the engine changes how every later case is coordinated, and an
 * edited file should not take effect because somebody restarted a pod. The
 * cost is that a fresh engine has nothing to run until somebody deploys, and
 * every case opened before then is worked by hand. This makes the act one
 * command on a local stack, through the API so the definition is validated
 * on the way in exactly as the Process Modeller's Deploy button does.
 *
 * Local development only: it signs in with the seeded administrator.
 *
 * Usage:
 *   npm run bpmn:deploy
 *   TAS_ADMIN_USER=admin-tax TAS_ADMIN_PASSWORD=... npm run bpmn:deploy
 */

const API = process.env['TAS_API'] ?? 'http://localhost:3000';
const KEYCLOAK = process.env['TAS_KEYCLOAK'] ?? 'http://localhost:8085';
const USER = process.env['TAS_ADMIN_USER'] ?? 'admin-tax';
const PASSWORD = process.env['TAS_ADMIN_PASSWORD'] ?? 'password';

async function main() {
  const tokenResponse = await fetch(
    `${KEYCLOAK}/realms/tax-assessment/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'tas-web',
        grant_type: 'password',
        username: USER,
        password: PASSWORD,
      }),
    },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Could not sign in as ${USER}: HTTP ${tokenResponse.status}`);
  }
  const { access_token: token } = await tokenResponse.json();

  const deployed = await fetch(`${API}/api/v1/processes/deploy/standard`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await deployed.json().catch(() => ({}));
  if (!deployed.ok) {
    throw new Error(`Deployment refused: HTTP ${deployed.status} ${JSON.stringify(body)}`);
  }
  console.log(
    `Deployed ${body.processDefinitionKey} version ${body.version} (deployment ${body.deploymentId}).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
