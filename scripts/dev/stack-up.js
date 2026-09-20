#!/usr/bin/env node
'use strict';

/**
 * Bring the local infrastructure up on podman, in the order that works.
 *
 * Three things go wrong on a Windows host and each one looks like a different
 * failure, which is why this is a script rather than a paragraph in a guide.
 *
 *   1. `podman machine start` reassigns the VM's ssh port but leaves the saved
 *      connections pointing at the old one, so every podman command fails with
 *      "connection refused" while the machine reports itself running.
 *   2. Container port publishing only reaches the Windows loopback when the
 *      bind happens after WSL's mirrored network is up. Start a container too
 *      early and it runs perfectly while nothing on the host can reach it,
 *      which no amount of restarting that container fixes.
 *   3. The VM shuts down when whatever started it exits, taking all five
 *      containers with it.
 *
 * Run it with `npm run dev:up:podman`. It is safe to run when the stack is
 * already up.
 */

const { execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const MACHINE = 'podman-machine-default';
const IDENTITY = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.local/share/containers/podman/machine/machine',
);

const CONTAINERS = ['tas-postgres', 'tas-redis', 'tas-minio', 'tas-mailpit', 'tas-keycloak'];

const PORTS = [
  ['Postgres', 5433],
  ['Redis', 6380],
  ['MinIO', 9000],
  ['Mailpit', 8025],
  ['Keycloak', 8085],
];

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function attempt(command, args) {
  try {
    return { ok: true, out: run(command, args) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** The port sshd is listening on inside the VM, which is the only authority. */
function liveSshPort() {
  const listeners = run('wsl', ['-d', MACHINE, '-u', 'root', '--', 'ss', '-lnt'], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

  const match = /0\.0\.0\.0:(\d{4,5})/.exec(listeners.replace(/\0/g, ''));
  if (!match) throw new Error('sshd is not listening inside the machine.');
  return match[1];
}

function repointConnections(port) {
  for (const [name, user, socket] of [
    [MACHINE, 'user', '/run/user/1000/podman/podman.sock'],
    [`${MACHINE}-root`, 'root', '/run/podman/podman.sock'],
  ]) {
    attempt('podman', ['system', 'connection', 'remove', name]);
    const args = ['system', 'connection', 'add', '--identity', IDENTITY];
    if (user === 'root') args.push('--default');
    args.push(name, `ssh://${user}@127.0.0.1:${port}${socket}`);
    run('podman', args);
  }
}

function reachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitFor(label, port, seconds) {
  for (let i = 0; i < seconds; i += 2) {
    if (await reachable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error(`  ${label} on ${port} never answered.`);
  return false;
}

async function main() {
  console.log('Starting the machine.');
  attempt('podman', ['machine', 'start']);

  const port = liveSshPort();
  console.log(`Machine ssh is on ${port}. Pointing podman at it.`);
  repointConnections(port);

  console.log(`Starting ${CONTAINERS.length} containers.`);
  const started = attempt('podman', ['-c', `${MACHINE}-root`, 'start', ...CONTAINERS]);
  if (!started.ok) {
    console.error(started.out.trim());
    process.exit(1);
  }

  console.log('Waiting for published ports on the Windows loopback.');
  const results = [];
  for (const [label, servicePort] of PORTS) {
    results.push([label, servicePort, await waitFor(label, servicePort, 90)]);
  }

  console.log('');
  for (const [label, servicePort, up] of results) {
    console.log(`  ${up ? 'ok  ' : 'FAIL'} ${label.padEnd(9)} ${servicePort}`);
  }

  if (results.some(([, , up]) => !up)) {
    console.error(
      '\nA container is running but its port does not reach the host. That is the bind-order\n' +
        'failure: stop everything, `wsl --shutdown`, then run this again so the binds happen\n' +
        'after the network is up.',
    );
    process.exit(1);
  }

  console.log('\nInfrastructure is up. Start the applications with:');
  console.log('  npm run start:api');
  console.log('  npm run start:web');
  console.log(
    '  OIDC_CLIENT_ID=tas-bpmn OIDC_CLIENT_SECRET=bpmn_local_dev_only \\\n' +
      '    java -jar apps/bpmn-engine/target/bpmn-engine-0.1.0.jar',
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
