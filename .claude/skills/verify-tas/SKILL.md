---
name: verify-tas
description: Launch the tax assessment system locally and drive it the way an officer does — browser through the Angular web app against the real API, Keycloak and Postgres — to prove a change works. Use when a change needs runtime evidence rather than a green unit suite, for lifecycle, role separation, register, portal or forms work.
---

# Verify the tax assessment system

The unit suites prove the money type, the transition table and one route at a
time. They pass whether or not an officer can move a case from opened to
closed. This skill is for the second question.

The primary surface is the **Angular web app** at `http://localhost:4200`,
signed in through Keycloak as one of ten seeded roles. The API also answers
directly on `http://localhost:3000` and is the right surface when the claim
under test is about a response body rather than a screen.

> **Status.** Written from the repository and `docs/running-locally.md`; the
> launch sequence below has been executed end to end on Windows with podman,
> and every readiness line in it was observed. The drive step is covered by
> `apps/web/e2e/`.

## Launch

Four things, in order. Each is a separate terminal; none of them daemonise.

```bash
npm run dev:up            # Postgres, Redis, Keycloak, MinIO, Mailpit
npm run db:migrate
npm run db:seed
npm run start:api         # terminal 2 — leave running
npm run start:web         # terminal 3 — leave running
```

**On podman rather than Docker Desktop**, the same commands work once the
docker CLI is pointed at podman's API socket:

```bash
export DOCKER_HOST=npipe:////./pipe/docker_engine   # podman machine publishes this
```

Three things had to be true on this machine before podman would serve it, and
each is worth checking before concluding the stack is broken:

- `/etc/wsl.conf` inside `podman-machine-default` needs `[boot] systemd=true`.
  Without it systemd is offline, sshd never starts, and `podman machine start`
  reports the machine as running while every connection is refused.
- `~/.wslconfig` needs `networkingMode=mirrored`. Without it the VM's published
  ports do not answer on `127.0.0.1`, which breaks the Keycloak redirect URIs
  and the Playwright `baseURL` even though the containers are healthy.
- `~/.wslconfig` needs `vmIdleTimeout=-1`, or the VM shuts down when the
  command that started it exits and takes all five containers with it.

## The workflow engine, optionally

```bash
OIDC_CLIENT_ID=tas-bpmn OIDC_CLIENT_SECRET=bpmn_local_dev_only \
  java -jar apps/bpmn-engine/target/bpmn-engine-0.1.0.jar
```

Needs Java 17. With it running, cases are coordinated: a newly opened case
reaches `DATA_READY` without anyone pressing a button, and SYSTEM transitions
fire on their own. Both states are correct, so a test that insists on one will
fail depending on whether somebody started the engine.

Prove the link rather than assuming it. `curl http://localhost:8080/actuator/health`
returns `{"status":"UP"}`, and `POST /api/v1/workflow/reconcile` as `admin-tax`
answers with `"engineReachable": true` and an empty `divergences` array.

Ready when all of these are true:

- Keycloak answers its discovery document:
  `curl http://localhost:8085/realms/tax-assessment/.well-known/openid-configuration`
  (30–60s on a first run — it imports the realm).
- The API prints `Authorization catalogue refreshed: 15 roles, 117 routes`.
  **Far fewer routes means migrations did not all run** — do not drive it.
- `curl http://localhost:3000/health/ready` returns
  `{"status":"up","components":{"database":{"status":"up"},"redis":{"status":"up"}}}`.
- `http://localhost:4200` redirects to the Keycloak login form.

Teardown is in §Cleanup. Do not use `npm run dev:reset`: it drops the volumes,
which throws away the seeded jurisdiction and anyone else's local data.

## Doctor

Before driving anything, and again whenever a run looks wrong:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
curl -s http://localhost:3000/health/ready
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4200
powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

Healthy is: five containers up, `status: up` for database and redis, `200`
from the web dev server, and a clean smoke test. A container up but the
readiness probe down is almost always the `citext` case in the
`docs/running-locally.md` troubleshooting section — the `.env` is pointing at a
different PostgreSQL than the containers.

**Isolation:** ports 3000, 4200, 5432, 8085 are fixed, and Keycloak's redirect
URI is registered for 4200 only. Two instances cannot run side by side without
re-registering the client. If the stack is already up and it is not yours,
say so and stop rather than driving someone's session.

## Drive

Playwright is already wired for this app — do not build a second harness.

```bash
npm run test:e2e                                    # every spec, serial
npx playwright test apps/web/e2e/01-lifecycle.spec.ts
npx playwright test --grep "objection"
npx playwright test --headed --debug                # watch it, step through
```

Facts that matter when writing a new drive:

- `apps/web/e2e/auth.setup.ts` signs in **once per role** through the real
  Keycloak form, then saves `sessionStorage` to `apps/web/e2e/.auth/<role>.json`
  and replays it with an init script. Not `storageState` — the app deliberately
  keeps tokens in `sessionStorage`. Never "fix" this by moving the app to
  `localStorage`.
- The ten roles live in `apps/web/e2e/roles.ts` (`ROLES`, `OFFICERS`,
  `PASSWORD`). A role missing from that list is never exercised.
- `apps/web/e2e/support/workbench.ts` exposes a `Workbench` page object; reach
  for it before writing raw selectors.
- Specs are **serial** (`fullyParallel: false`, `workers: 1`) and `retries: 0`,
  because a case is one stateful thing the roles act on in order. A spec that
  only passes on a retry is a defect report, not a flake.
- Prefer role names, ARIA labels and route paths as handles. The navigation
  labels each role should and should not see are asserted from `NAVIGATION` in
  `roles.ts`.

For an API-level claim, sign in with the password grant against the realm and
call `http://localhost:3000` directly; the OpenAPI is at `/api/docs`.

## Evidence

A proof is: the user path actually driven, the action **and** the resulting
state captured, and the side effect checked where there is one.

- Playwright writes to `playwright-report/` (HTML) and `test-results/`
  (traces, screenshots, videos on failure). `npm run test:e2e:report` opens it.
- Both directories are gitignored. **Copy anything that has to survive out of
  them** before the next run overwrites it, into a path you name in your reply.
- For a state claim, show the row as well as the screen: query Postgres in the
  `tax` schema. Remember `tax_assessment_event` and `tax_assessment_evidence`
  are append-only — read them, never repair them.
- For a notice or a mail claim, Mailpit holds what was sent.
- Do not mock the API, Keycloak or the database to make a run pass. Mocks are
  for a production boundary that already isolates an external system.

## Cleanup

```bash
# stop the API and web terminals you started (Ctrl-C in each)
npm run dev:down          # containers down, volumes kept
```

Kill only what you started, by terminal or by PID; never by process name —
`node` on this machine is not only this app. `npm run dev:down` keeps the
volumes; `dev:reset` does not, and is not a cleanup step.

Evidence survives cleanup: `playwright-report/` and `test-results/` are on
disk, and anything you copied out of them stays where you put it.

## Helpers

- `scripts/smoke-test.ps1` — end-to-end reachability check, used in §Doctor.
- `npm run test:e2e:ui` — Playwright's UI mode, for exploring selectors.
- `npm run security:probe` — boundary probe over the RBAC surface.
- `npm run load:seed` — seeds the register at scale; slow, and it changes data
  every later run will see. Ask before running it.

The feature map is in [`features/README.md`](features/README.md). A proof that
drives one convenient entry point is incomplete when the map lists others.
