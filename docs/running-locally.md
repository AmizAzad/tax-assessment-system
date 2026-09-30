# Running locally on Windows

Verified on this machine: Windows 11, Node 22.18, npm 10.9, Docker 29.7, Java 17.0.18, Maven 3.9.6, Windows PowerShell 5.1.

> **Read this first.** Phases 0 to 8 are built. You can drive a complete
> assessment — opening, evidence, calculation, review, approval, notice,
> service, objection, appeal, reassessment, settlement, closure — through the
> API (§12, §13) or through the browser (§16). A second jurisdiction runs on
> configuration alone (§14). [What you can and cannot test](#what-you-can-and-cannot-test)
> is explicit about what remains.
>
> **If `npm run db:migrate` fails with `type "citext" does not exist`,** your
> `.env` is pointing at a different PostgreSQL than the containers. See
> [Troubleshooting](#troubleshooting) — it is the first thing to check, not a
> migration bug.

---

## 1. Prerequisites

| Tool           | Version | Check            | Needed for                                |
| -------------- | ------- | ---------------- | ----------------------------------------- |
| Node.js        | 22 LTS  | `node --version` | Everything                                |
| npm            | 10+     | `npm --version`  | Everything                                |
| Docker Desktop | running | `docker ps`      | Postgres, Redis, Keycloak, MinIO, Mailpit |
| Java           | 17+     | `java -version`  | BPMN engine only (optional)               |
| Maven          | 3.9+    | `mvn --version`  | BPMN engine only (optional)               |

You can do everything except the BPMN engine without Java.

---

## 2. First-time setup

Open **PowerShell** in the project root.

```powershell
cd "C:\Users\amiz.azad\Downloads\Amiz Azad\Personal projects\tax_assessment_system"

npm install
Copy-Item .env.example .env
```

Start the infrastructure:

```powershell
npm run dev:up
```

That starts five containers. Give Keycloak 30–60 seconds on a first run — it imports the realm:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}"
```

Wait until Keycloak answers (this returns the OIDC discovery document):

```powershell
curl.exe http://localhost:8085/realms/tax-assessment/.well-known/openid-configuration
```

Create the schema and load the demo jurisdiction:

```powershell
npm run db:migrate
npx sequelize-cli db:seed:all --config db/config.js --seeders-path db/seeds --env development
```

The seed is not optional for the end-to-end suite or the walkthroughs below:
it creates the demo company, Acme Trading Ltd, its filed return and account
entries, and links the `acme-finance` portal login to it. Without it the
portal user acts for nobody and every GB walkthrough has no taxpayer to open
a case on.

---

## 3. Start the API

```powershell
npm run start:api
```

Leave it running. You should see:

```
API listening on http://localhost:3000
OpenAPI at http://localhost:3000/api/docs
Readiness at http://localhost:3000/health/ready
Cross-origin callers allowed: http://localhost:4200
Authorization catalogue refreshed: 15 roles, 117 routes
```

If the catalogue line reports far fewer routes than that, the migrations have
not all run — check §2 and the Troubleshooting entry on `citext`.

Check it in a **second** PowerShell window:

```powershell
curl.exe http://localhost:3000/health/ready
```

```json
{ "status": "up", "components": { "database": { "status": "up" }, "redis": { "status": "up" } } }
```

---

## 3b. Start the front end

In a **third** PowerShell window:

```powershell
npm run start:web
```

Then open **http://localhost:4200**. You will be redirected to Keycloak — sign in as
`assessor` / `password`.

The dev server proxies `/api` to the API on port 3000, so there is no CORS setup to do.

**Where to start depends on what you want to see.**

For the working system: **Dashboard**, then **Cases**. §16 walks a case through
the workbench.

For the configuration story: **Forms -> "Open the builder"**. Drop a Section onto
the canvas, add a Dropdown and a Text field inside it, then give the text field a
rule: _when_ dropdown _equals_ some value, _then_ show it. Hit **Preview** and
watch the rule fire in the real renderer. As `admin-tax` you can then **Publish**
it, and it becomes a real template the API stores.

The same renderer draws the adjustment form in the workbench, from the published
`TA-06-ADJUSTMENT` template — so a reason code added in the builder appears in
the officer's dropdown without a release (§25).

> If port 4200 is busy: `npm start -- --port 4300`. Keycloak's redirect URI is registered for
> 4200, so you would also need to add the new port to the `tas-web` client in the Keycloak
> admin console.

---

## 4. Verify everything at once

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
```

Expected: **Failed: 0**.

It checks the endpoints that should work _and_ the ones that should be refused.
A run where nothing is refused would mean authorisation is rubber-stamping.

For the wider check — anonymous access, forged tokens, cross-taxpayer access,
export scope, security headers and the rate limits — use the boundary probe in
§21. It is the one to run after changing anything about authorisation.

---

## 5. Where things are

| Service                       | URL                            | Credentials                  |
| ----------------------------- | ------------------------------ | ---------------------------- |
| **Web app**                   | http://localhost:4200          | sign in via Keycloak         |
| **API**                       | http://localhost:3000          | bearer token                 |
| **OpenAPI (Swagger UI)**      | http://localhost:3000/api/docs | —                            |
| **Keycloak admin**            | http://localhost:8085          | `admin` / `admin`            |
| **MinIO console**             | http://localhost:9001          | `tas` / `tas_local_dev_only` |
| **Mailpit** (captured e-mail) | http://localhost:8025          | —                            |
| PostgreSQL                    | `localhost:5433`               | `tas` / `tas_local_dev_only` |
| Redis                         | `localhost:6380`               | —                            |

**The non-default ports are deliberate.** You already have a native PostgreSQL on 5432 and a Tomcat on 8081. A container on the same port is silently shadowed and the symptom never points at the cause — Postgres gives `password authentication failed` _against the wrong server_, and Keycloak returns a Tomcat 404 from its token endpoint. Both cost time here. Override with `DB_PORT` / `REDIS_PORT` / `KEYCLOAK_PORT` in `.env` if you need to.

### Test users

Realm `tax-assessment`, password `password` for all:

| Username            | Roles                             |
| ------------------- | --------------------------------- |
| `assessor`          | `TA_ASSESSOR`                     |
| `reviewer`          | `TA_REVIEWER`                     |
| `approver`          | `TA_APPROVER_L1`                  |
| `supervisor`        | `TA_SUPERVISOR`                   |
| `notice-issuer`     | `TA_NOTICE_ISSUER`                |
| `objection-officer` | `TA_OBJECTION_OFFICER`            |
| `appeals-officer`   | `TA_APPEALS_OFFICER`              |
| `committee-member`  | `TA_COMMITTEE_MEMBER`             |
| `admin-tax`         | `TA_ADMIN`, `TA_AUDITOR_READONLY` |
| **`acme-finance`**  | `TA_TAXPAYER` — the portal (§20)  |

Every officer account also holds `MFA_REQUIRED`. It does nothing until the
conditional one-time-code flow is bound, which it deliberately is not — §25.

`tas-bpmn` is not a login. It is the engine's service account, holding `SYSTEM`,
granted exactly the routes a service task calls (§19).

---

## 6. Using the API by hand

### Get a token

```powershell
$body = @{
  client_id  = 'tas-web'
  username   = 'assessor'
  password   = 'password'
  grant_type = 'password'
}
$token = (Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:8085/realms/tax-assessment/protocol/openid-connect/token' `
  -Body $body).access_token
```

### Who am I, and what may I do?

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/v1/me' `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

```json
{
  "username": "assessor",
  "userId": 1,
  "roleCodes": ["TA_ASSESSOR", "MFA_REQUIRED"],
  "jurisdictionCode": "GB",
  "permissions": [
    "GET /api/v1/cases",
    "POST /api/v1/cases",
    "POST /api/v1/cases/:id/calculate",
    "GET /api/v1/dashboard/summary",
    "POST /api/v1/exports",
    "…"
  ]
}
```

An assessor holds around fifty of the 117 catalogued routes; a supervisor more,
a taxpayer nine.

`/me` returns the _exact_ set of routes that caller may invoke. It is the quickest way to see whether a permission change did what you intended.

### Read reference data

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/v1/masters/ADJUSTMENT_TYPE' `
  -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 5
```

Seeded groups: `ADJUSTMENT_TYPE`, `ADJUSTMENT_REASON`, `OBJECTION_GROUND`, `APPEAL_FORUM`, `CLOSURE_REASON`.

### Watch authorisation refuse you

```powershell
# The assessor has no grant on this route -> 403
Invoke-RestMethod -Uri 'http://localhost:3000/api/v1/masters' `
  -Headers @{ Authorization = "Bearer $token" }
```

Now as an administrator:

```powershell
$adminBody = @{ client_id='tas-web'; username='admin-tax'; password='password'; grant_type='password' }
$adminToken = (Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:8085/realms/tax-assessment/protocol/openid-connect/token' `
  -Body $adminBody).access_token

Invoke-RestMethod -Uri 'http://localhost:3000/api/v1/admin/permissions' `
  -Headers @{ Authorization = "Bearer $adminToken" } | ConvertTo-Json -Depth 5
```

### Swagger UI

http://localhost:3000/api/docs — click **Authorize**, paste the token, and call endpoints from the browser.

---

## 7. Prove authorisation fails closed

Worth doing once, because it is the security property the design rests on.

```powershell
docker stop tas-redis
```

Readiness now reports Redis down and returns **503** — correct: an instance that cannot authorise anyone should leave the load balancer rather than 403 everybody.

```powershell
curl.exe -i http://localhost:3000/health/ready
```

Every authenticated route now returns **403**, including as an administrator. That is the design: a cache outage must not open every route.

```powershell
docker start tas-redis
```

---

## 8. Run the test suites

```powershell
# 516 TypeScript tests
#   282 API, 108 dynaforms-core, 74 decimal, 30 web, 22 contracts
npm test

# The money primitive, with its 100% coverage gate
cd packages\decimal ; npx jest --coverage ; cd ..\..

# 6 BPMN engine integration tests against a real Flowable engine (needs Java)
cd apps\bpmn-engine ; mvn test ; cd ..\..

# What CI runs
npm run verify
```

Two more that need the stack up and are deliberately **not** part of `npm test`:

```powershell
npm run security:probe   # 44 checks against the running API (§21)
bash scripts/dr/rehearse.sh
```

---

## 9. The BPMN engine (optional)

Needs Java 17+ and Maven.

```powershell
cd apps\bpmn-engine
mvn spring-boot:run
```

Starts on **http://localhost:8080**, creating its tables in the `flowable` schema on first run. Health: http://localhost:8080/actuator/health

**Then deploy the process definition, once:**

```powershell
npm run bpmn:deploy
```

A fresh engine has no definitions. Deployment is deliberately an act rather
than a boot step (an edited file should not take effect because somebody
restarted a pod), so until an administrator deploys, every case opened is
worked by hand and the engine answers each start with
`No process definition found for key 'TAX_ASSESSMENT_MAIN'`. The script signs
in as the seeded `admin-tax` and calls `POST /api/v1/processes/deploy/standard`,
which validates the definition first, exactly as the Process Modeller's Deploy
button does. Running it again with an unchanged file is a no-op.

**The API drives it.** Opening a case starts a process, the engine calls back to
retrieve evidence, and a task lands in the right officer's inbox. That loop is
§19, which is the section to read — this one only covers starting the process.

The engine authenticates as itself through a Keycloak service account, so it
needs a secret:

```powershell
$env:OIDC_CLIENT_SECRET = "bpmn_local_dev_only"
```

Without it, every service task fails with 401 and the case stays where it is —
which is the designed behaviour, not a crash, but it will look like nothing is
happening.

---

## 10. Inspect the database

```powershell
docker exec -it tas-postgres psql -U tas -d tax_assessment
```

```sql
\dn                          -- schemas: platform, forms, workflow, tax, flowable, keycloak
\dt platform.*               -- 37 tables
\dt tax.*                    -- 34 tables: case, event, evidence, calculation, notice, dispute, closure
\dt workflow.*               -- 7 tables: the read model
\dt forms.*                  -- templates and submissions

-- The audit ledger refuses to be edited, by anyone (ADR-013)
UPDATE tax.tax_assessment_event SET event_type = 'X' WHERE id = 1;
-- ERROR:  Table tax.tax_assessment_event is append-only: UPDATE is refused

SELECT role_code, role_name FROM platform.role ORDER BY 1;
SELECT permission_key, required_level FROM platform.permission ORDER BY 1;

-- Who can do what
SELECT r.role_code, p.permission_key, rp.granted_level
  FROM platform.role_permission rp
  JOIN platform.role r       ON r.id = rp.role_id
  JOIN platform.permission p ON p.id = rp.permission_id
 ORDER BY 1, 2;
```

Or use any GUI client against `localhost:5433`, database `tax_assessment`, user `tas`, password `tas_local_dev_only`.

---

## 11. Stopping and resetting

```powershell
npm run dev:down     # stop containers, keep data
npm run dev:reset    # destroy volumes and start clean -- then re-run db:migrate and the seed
npm run dev:logs     # tail container logs
```

Stop the API with `Ctrl+C`. If port 3000 is still held afterwards:

```powershell
netstat -ano | Select-String ":3000" | Select-String "LISTENING"
taskkill /F /PID <pid>
```

---

## What you can and cannot test

### Working now

- **Angular SPA**: Keycloak sign-in (PKCE), permission-filtered navigation, language switcher with RTL
- **The DynaForms renderer**, running the same engines as the server
- **The visual form builder**: build, preview, save and publish a template
- **The whole assessment lifecycle, through the browser or the API**: evidence, calculation, approval, notice, service, objection, appeal, reassessment, settlement and closure (sections 12, 13 and 16)
- **A second jurisdiction** assessing correctly on its own rules, with no code change (section 14)
- **Management and reconciliation reports** (section 15)
- **Work coordinated by the BPMN engine**, with a populated task inbox (section 19)
- **A taxpayer portal**, scoped so a taxpayer sees only their own affairs (section 20)
- **A security boundary probe and a DR rehearsal**, both runnable (section 21)
- Authorisation: permission catalogue, role-based grants, **fail-closed** behaviour
- Automatic local user provisioning from the IdP subject
- OpenAPI / Swagger UI
- BPMN engine with the `apiInvoker` delegate

Also working, and added after the sections below were first written:

- **The dashboard** — tiles, charts, ageing, service levels and statutory
  exposure, all scoped to the caller (section 22)
- **Configurable register columns, and CSV / XLSX export** (section 23)
- **The process journey** on a case, and the **BPMN modeller** (section 24)
- **Draft autosave, keyboard navigation, and a configured MFA flow** (section 25)
- **Public notice verification** — no account needed, status only
- **Append-only audit**, enforced by the database against everyone including
  the owner

### Not built

| Missing                                  | What to do instead                                                |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Arabic notice PDFs                       | `pdfkit` is Latin-1; an Arabic notice is refused, not blank       |
| A live bank feed or withholding register | Both evidence providers read our own tables (ADR-010)             |
| Dispute forms as DynaForms templates     | The adjustment form is one; objection and appeal forms are markup |
| An axe accessibility audit               | The keyboard and focus work is done; nothing has been audited     |

And one caveat that is not a missing feature: **every rate, penalty, interest
figure and deadline is illustrative and has not been through a tax SME.** They
are configuration, so correcting one is a data change — but do not quote a
figure from this system to anybody.

---

## 12. Walk a complete assessment

This is the end-to-end path, in order. Every command below has been run against
a clean stack. Amounts come from the demo company seeded by `npm run db:seed`.

Taxpayer ids follow the order rows were written. On a stack built as section 2
describes, migrations run before seeds, so the Saudi company from migration
`20261006000100` is taxpayer **1** and the seeded Acme Trading Ltd
(TIN `1234567890`) is taxpayer **2**. A database that was seeded before that
migration existed has them the other way round; check with
`SELECT id, tin, name FROM platform.taxpayer` rather than assuming.

Get tokens for the four people involved:

```powershell
function Get-Token($user) {
  (Invoke-RestMethod -Method Post `
    -Uri "http://localhost:8085/realms/tax-assessment/protocol/openid-connect/token" `
    -Body @{ client_id='tas-web'; username=$user; password='password'; grant_type='password' }
  ).access_token
}
$sup = Get-Token supervisor; $ass = Get-Token assessor
$rev = Get-Token reviewer;   $app = Get-Token approver
$adm = Get-Token admin-tax

function H($t) { @{ Authorization = "Bearer $t" } }
```

`$adm` is used by sections 17, 19 and 23; the rest of this walkthrough does not
need it.

**1. Open the case** (supervisor). A second open case for the same taxpayer,
tax type and year is refused with 409 — reassess the first instead.

```powershell
$case = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/cases -Headers (H $sup) `
  -ContentType application/json -Body (@{
    taxpayerId=2; taxTypeCode='CIT'; assessmentYear='2024'
    assessmentType='DESK'; triggerPath='RISK'; limitationDate='2029-12-31'
  } | ConvertTo-Json)
$id = $case.id
```

**2. Retrieve the evidence** (assessor). This fans out to every configured
source, hashes each response and freezes it. The case advances to `DATA_READY`
only if every _mandatory_ source succeeded — a failed one leaves the case where
it is and records why.

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/evidence/refresh" -Headers (H $ass)
```

`RETRIEVE_DATA` is a SYSTEM-only transition: no human role holds it, because
"the data arrived" is not a claim a caseworker should be able to make by
pressing a button.

**3. Assign and start.**

```powershell
$body = @{ action='ASSIGN'; assigneeUsername='assessor' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/transition" -Headers (H $sup) -ContentType application/json -Body $body
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/transition" -Headers (H $ass) -ContentType application/json -Body (@{action='START'}|ConvertTo-Json)
```

**4. Adjust** (optional). An adjustment above the materiality threshold without
a narrative is refused with 400: a figure a reviewer cannot understand is not
a finding.

**5. Calculate.** The figures and the full trace come back together.

```powershell
$calc = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/calculate" -Headers (H $ass)
$calc.trace | Format-Table sequence, step, expression -AutoSize
```

Expected for the demo company:

```
1. BASE_DETERMINATION  200000 + 0 = 200000
2. LOSS_SET_OFF        OLDEST_FIRST, ceiling 200000 -> relieved 30000
3. TAXABLE_BASE        (200000 - 30000) rounded HALF_UP to 0 dp = 170000
4. RATE_APPLICATION    (250000 - 170000) x 0.015 = 1200 relief; 42500 - 1200 = 41300
7. CREDITS             CIT_INTEREST_WHT: 2500 applied of 2500 available
9. PENALTY             fixed 100: 41 days late, charged beyond 0 days
10. INTEREST           38800 x 0.0775 x 345/365 = 2842.23...
11. NET_POSITION       (38800 + 100 + 2842) - 25000 = 16742 (payable)
```

Every line is checkable by hand. That is the point of the trace.

**6. Submit, and watch segregation of duties refuse the shortcut.**

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/transition" -Headers (H $ass) -ContentType application/json -Body (@{action='SUBMIT'}|ConvertTo-Json)

# The same person reviewing their own work -> 403
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/transition" -Headers (H $ass) -ContentType application/json -Body (@{action='ACCEPT'}|ConvertTo-Json)

# The reviewer -> REVIEWED
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/transition" -Headers (H $rev) -ContentType application/json -Body (@{action='ACCEPT'}|ConvertTo-Json)
```

**7. Route for approval.** The band comes from the configured delegation
limits and the amount, never from the caller.

```powershell
(Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/route-approval" -Headers (H $rev)).derivation
# Net payable 16742 GBP falls in the band 0.0000 to 100000.0000,
# which requires 1 approval(s) at TA_APPROVER_L1.
```

**8. Approve and finalise.** Finalising consumes the losses the calculation
relied on, under a row lock, so two cases cannot relieve the same loss twice.

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/transition" -Headers (H $app) -ContentType application/json -Body (@{action='APPROVE'}|ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/finalise" -Headers (H $app)
```

**9. Confirm the figures are now frozen.**

```powershell
# 409: a finalised assessment is the legal determination
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/calculate" -Headers (H $ass)

# The loss is now spent
(Invoke-RestMethod -Uri http://localhost:3000/api/v1/taxpayers/1/account -Headers (H $ass)).losses
```

### Statutory dates

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/cases/$id/deadlines" -Headers (H $ass) | Format-Table deadlineType, dueDate, derivation
```

```
FILING   2025-12-31  PERIOD_END 2024-12-31 plus 12 months (CALENDAR_DAYS)
PAYMENT  2025-10-01  PERIOD_END 2024-12-31 plus 9 months and 1 day (CALENDAR_DAYS)
```

Each date says how it was derived, because that sentence ends up on a penalty
notice a taxpayer may challenge.

---

## 13. Notices, disputes, reassessment and closure

Continues from §12, which finalised a case. Reuse the `Get-Token` helper and
`$id` from there. Two extra users are needed, and the realm now ships them:

```powershell
$ni  = Get-Token notice-issuer
$obj = Get-Token objection-officer
$apl = Get-Token appeals-officer
```

**1. Issue the notice.** Only from a finalised assessment. The figures come
from the approved calculation, never from a fresh one.

```powershell
$notice = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/notices" `
  -Headers (H $ni) -ContentType application/json -Body (@{ noticeType='ASSESSMENT' } | ConvertTo-Json)
$notice.noticeNumber; $notice.body
```

**2. Confirm it has not been altered.** The hash is over the content, not the
PDF bytes — a PDF embeds a timestamp, so a byte hash would report every
re-render as tampering.

```powershell
(Invoke-RestMethod -Uri "http://localhost:3000/api/v1/notices/$($notice.uuid)/verify" -Headers (H $ni)).intact
# True
```

**3. Download the PDF.**

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/v1/notices/$($notice.uuid)/document" `
  -Headers (H $ni) -OutFile notice.pdf
```

**4. Serve it, and watch deemed service work.** Registered post is deemed
served two working days later, counted on the jurisdiction's calendar.

```powershell
$serve = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/notices/$($notice.uuid)/serve" `
  -Headers (H $ni) -ContentType application/json -Body (@{
    channel='REGISTERED_POST'; addressee='Acme Trading Ltd, 12 High Street, London'
    proofReference='RM123456789GB'
  } | ConvertTo-Json)
$serve.deemedServedOn
```

Posted on a Saturday, this returns the **following Tuesday**. The objection
window then runs from that date, not from despatch:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/cases/$id/deadlines/recorded" -Headers (H $ni)
```

**5. A returned letter reverts the notice to unserved.**

```powershell
Invoke-RestMethod -Method Post -Headers (H $ni) -ContentType application/json `
  -Uri "http://localhost:3000/api/v1/notices/$($notice.uuid)/service/1/outcome" `
  -Body (@{ status='RETURNED'; failureReason='Addressee has left this address' } | ConvertTo-Json)

# The notice is ISSUED again, not SERVED
(Invoke-RestMethod -Uri "http://localhost:3000/api/v1/notices/$($notice.uuid)" -Headers (H $ni)).status
```

Serving again by email re-anchors the objection deadline to the new deemed date.

**6. File an objection.** Accepted even out of time; lateness is recorded and
admissibility is decided separately.

```powershell
$o = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/objections" `
  -Headers (H $obj) -ContentType application/json -Body (@{
    groundsSummary='The third-party revenue figure double counts an intercompany sale.'
    grounds=@(@{ groundCode='FACTUAL_ERROR'; detail='Counted twice'; disputedAmount='40000.00' })
    filedChannel='POST'
  } | ConvertTo-Json -Depth 5)
"in time: $($o.was_in_time), days late: $($o.days_late)"
```

**7. Admit it, take an opinion, decide it.** A supervisor cannot decide — the
state machine names only `TA_OBJECTION_OFFICER`, and the permission grants were
narrowed to match.

```powershell
Invoke-RestMethod -Method Post -Headers (H $obj) -ContentType application/json `
  -Uri "http://localhost:3000/api/v1/objections/$($o.uuid)/admissibility" `
  -Body (@{ admissibility='ADMITTED'; reason='Filed in time, grounds properly particularised.' } | ConvertTo-Json)

Invoke-RestMethod -Method Post -Headers (H $obj) -ContentType application/json `
  -Uri "http://localhost:3000/api/v1/objections/$($o.uuid)/decision" `
  -Body (@{ decision='REJECTED'; reason='The reconciliation supplied does not evidence a double count.' } | ConvertTo-Json)
```

Deciding against a panel majority is permitted, and logged — it is the decision
someone will later be asked to justify.

**8. Appeal.** The forum must be one the jurisdiction recognises.

```powershell
$a = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/appeals" `
  -Headers (H $apl) -ContentType application/json -Body (@{
    forumCode='FIRST_TIER_TRIBUNAL'
    groundsSummary='The objection decision misapplied the reconciliation basis.'
    disputedAmount='10000.00'; externalReference='TC/2026/04412'; collectionStayed=$true
  } | ConvertTo-Json)

# An unknown forum is refused, and the message lists the configured ones.
```

Record the outcome, then implement it. The two are separate acts on purpose:

```powershell
Invoke-RestMethod -Method Post -Headers (H $apl) -ContentType application/json `
  -Uri "http://localhost:3000/api/v1/appeals/$($a.uuid)/outcome" `
  -Body (@{ outcome='VARIED'; reason='The tribunal reduced the adjustment to 25,000.' } | ConvertTo-Json)

# Decided but not yet given effect -> shows in the register
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/disputes?overdueImplementation=true" -Headers (H $apl)

Invoke-RestMethod -Method Post -Headers (H $apl) -ContentType application/json `
  -Uri "http://localhost:3000/api/v1/appeals/$($a.uuid)/implement" `
  -Body (@{ note='Reassessment raised to give effect to the decision.' } | ConvertTo-Json)
```

**9. Reassess in place.** The case status decides the shape; the caller does
not choose.

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/reassess" `
  -Headers (H $sup) -ContentType application/json -Body (@{
    grounds='The tribunal varied the assessment, reducing the adjustment from 40,000 to 25,000.'
  } | ConvertTo-Json)
```

Rework the figures (`START`, adjust `DEDUCT`, `calculate`) and compare versions:

```powershell
$d = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/cases/$id/calculation/delta" -Headers (H $sup)
"$($d.from) -> $($d.to): $($d.netMovement) ($($d.direction))"
$d.lines | Where-Object movement -ne '0.00' | Format-Table label, previous, revised, movement
```

Then drive it through approval again. The assessor **can** resubmit their own
reworked case; only the review and approval steps are barred to them.

**10. Pay, settle, close.** Settlement is evaluated from the payments, never
asserted.

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/taxpayers/1/account" `
  -Headers (H $sup) -ContentType application/json -Body (@{
    entryType='PAYMENT'; taxTypeCode='CIT'; assessmentYear='2024'
    amount='12483.00'; currencyCode='GBP'; valueDate='2026-09-12'
    sourceReference='BANK-FINAL-001'
  } | ConvertTo-Json)
# -> settlements[0].settled = True, case becomes SETTLED

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/close" `
  -Headers (H $sup) -ContentType application/json -Body (@{
    reasonCode='SETTLED_IN_FULL'; narrative='Varied on appeal, revised figure paid in full.'
  } | ConvertTo-Json)
```

The closure record freezes the position and sets a retention date. A legal hold
outranks it:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/cases/$id/legal-hold" `
  -Headers (H $sup) -ContentType application/json `
  -Body (@{ hold=$true; reason='Judicial review threatened by the taxpayer.' } | ConvertTo-Json)
```

---

## 14. The second jurisdiction

The proof that a jurisdiction is configuration, not code. Saudi Arabia is
seeded by migration `20261006000100`.

```powershell
# Najd Industrial Co. is taxpayer 1 on a fresh stack (see section 12)
$sa = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/cases -Headers (H $sup) `
  -ContentType application/json -Body (@{
    taxpayerId=1; taxTypeCode='CIT'; assessmentYear='2024'
    assessmentType='DESK'; triggerPath='RISK'; limitationDate='2030-12-31'
  } | ConvertTo-Json)

$sa.currencyCode   # SAR, read from the SA rule set - not a default
```

Its deadlines use a **Friday/Saturday** weekend and a 120-day filing rule:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/cases/$($sa.id)/deadlines" -Headers (H $sup) |
  Format-Table deadlineType, dueDate, derivation
```

Run evidence, assign, start, add an adjustment and calculate. The trace shows a
flat 20% with **no marginal relief**, percentage penalties and a 360-day
interest count — all from configuration, on the same pipeline:

```
 4. [RATE_APPLICATION] 800000 x 0.2 = 160000
 8. [PENALTY]          160000 x 0.01 = 1600
 9. [PENALTY]          160000 x 0.05 = 8000
10. [INTEREST]         160000 x 0.05 x 500/360 = 11111.11...
11. [NET_POSITION]     (160000 + 9600 + 11111) - 0 = 180711 (payable)
```

---

## 15. Reports

```powershell
foreach ($r in 'assessment-summary','collection','adjustment-analysis',
                'dispute-outcomes','ageing','deadline-exposure','unserved-notices') {
  "=== $r ==="
  Invoke-RestMethod -Uri "http://localhost:3000/api/v1/reports/$r" -Headers (H $sup) | Format-Table
}
```

The one to run on a schedule:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/v1/reports/reconciliation -Headers (H $sup)
```

It lists places where the register contradicts itself. Every row is a defect,
not a metric, and **an empty result is the expected answer**.

---

## 16. Using it through the browser

Sections 12 to 15 drive the system through the API. Everything there is also
available as a screen.

```powershell
npm run dev:up           # Postgres, Redis, Keycloak, MinIO, Mailpit
npm run db:migrate
npm run db:seed
npm run start:api
npm run start:web
```

Open `http://localhost:4200` and sign in. Which navigation entries appear
depends on your permissions: the menu is filtered by the same catalogue the API
enforces, so an assessor and a supervisor see different things.

### Sign-ins

| User                | Password   | Sees                                             |
| ------------------- | ---------- | ------------------------------------------------ |
| `assessor`          | `password` | Register, queues, their own cases                |
| `reviewer`          | `password` | Review queue                                     |
| `approver`          | `password` | Approval queue                                   |
| `supervisor`        | `password` | Everything except objection decisions and admin  |
| `notice-issuer`     | `password` | Notice issue and service                         |
| `objection-officer` | `password` | Objection admissibility and decisions            |
| `appeals-officer`   | `password` | Appeal hearings, outcomes, implementation        |
| `committee-member`  | `password` | Objection panel opinions                         |
| `admin-tax`         | `password` | Administration, reconciliation, process modeller |
| `acme-finance`      | `password` | **My Tax Affairs** — the taxpayer portal only    |

### Working a case

**Cases → Open a case**, then the workbench opens on the case with nine tabs.

1. **Evidence** — press _Retrieve evidence_. The panel shows every configured
   source and its outcome, not just the figures. A failed mandatory source
   leaves the case where it is and says why; that is the difference between an
   assessment that is complete and one that merely looks complete.
2. **Adjustments** — the amount is a text box, not a number input, and is sent
   as typed. A `type="number"` field would hand JavaScript a double before the
   server ever saw the figure.
3. **Calculation** — press _Calculate_. The trace below the summary is the
   point of the screen: every line is arithmetic you can check by hand.
   _What changed_ compares the two most recent versions line by line.
4. **Deadlines & SLA** — statutory dates and internal service clocks, in two
   panels. They are separated deliberately: a missed service standard is never
   a time bar.
5. **Notices** — issue, _Verify_ (shows both hashes), download the PDF, serve
   through a channel, and record delivery or return.
6. **Disputes** — file an objection, rule on admissibility, record opinions and
   a decision; file an appeal, record what the forum held, then implement it.
7. **Closure** — reassess, see the whole lineage of the period, close with a
   retention class, and place or lift a legal hold.
8. **Journey** — the process diagram with this case's position marked: green
   has finished, amber is waiting on somebody now. A case with no process says
   so rather than showing an error, because that is a normal state (§24).
9. **Timeline** — the ledger. Every movement, written with the status change it
   accompanies. It cannot be edited by anyone, including whoever holds the
   database credentials.

The **Actions** bar above the tabs offers only what the current status permits.
Those buttons are a courtesy, not the control: the server re-checks every one,
and a refusal shows its own message — _"Action ACCEPT requires one of
[TA_REVIEWER]; caller holds [TA_ASSESSOR]"_ — which tells you what to do next.

### Other screens

- **Dashboard** — the screen to open first. Everything on it is scoped to you,
  and it says so; assessed and collected are never added together (§22).
- **Register** — the columns come from configuration, not from the code, and
  the whole filtered list exports to CSV or XLSX (§23).
- **Process Modeller** — author the coordination process, validate it against
  the rules the deploy endpoint enforces, deploy it (§24). Administrators only.
- **My Tax Affairs** — what a taxpayer sees. Sign in as `acme-finance` (§20).
- **My Queues** — seven stage queues with counts. Every queue is visible to
  everyone, because a queue with nothing in it for you still tells you the work
  exists and who has it.
- **Disputes** — the register across all cases. Tick _decided but not
  implemented_ to find appeals the authority has won and never applied.
- **Selection** — score taxpayers against the risk rules, see exactly which
  rules fired on each, then open cases with a cap. Scoring opens nothing.
- **Rule Sets** — rate configuration and the simulator. Simulating a draft
  replays it over historic finalised cases and totals the movement. Run it
  before publishing anything.
- **Reports** — seven management reports, plus **Reconciliation**, which lists
  places where the register contradicts itself. An empty result is the expected
  answer.
- **Administration** — the route catalogue, delegation limits, scheduled jobs,
  and your own effective permissions. If a screen is missing, that last tab
  usually says why.

---

## 17. The worker

Scheduled work — deadline sweeps, auto-closure, notification dispatch, and
producing queued exports — runs in the API by default, so a single
`npm run start:api` behaves as it always has.

To run it in its own process:

```powershell
npm run start:worker
```

It opens no HTTP port. Every job claims a cross-replica lock before running, so
the API and the worker can run together and neither will double-send a
deadline warning.

In a deployment, set `SCHEDULER_ENABLED=false` on the API and leave it unset on
the worker. The jobs are exclusive either way; the flag stops the API spending
its event loop sweeping a large register.

Check what has run:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/v1/admin/jobs -Headers (H $adm)
```

---

## 18. Load testing

```powershell
# Seed. The taxpayer pool has to be large enough: a live case is unique per
# taxpayer, tax type and year, so 200,000 taxpayers over 7 years caps at 1.4M.
node scripts/load/seed-register.js --cases 1000000 --taxpayers 200000 --batch 20000

# Measure, then clean up
node scripts/load/seed-register.js --clean
```

The script refuses to run against a database that both holds real cases and is
not obviously a test one.

Measured at 920,003 cases: a filtered register page is **42 ms**, unfiltered
**244 ms**, and the heaviest report **433 ms**. The database accounts for
80–100 ms of the slowest two, which is inherent to an aggregate over the whole
register.

---

## 19. The process engine

Work is coordinated by Flowable. The API owns case status; the engine owns who
is asked to act, in what order, and what happens when nobody does.

```powershell
cd apps\bpmn-engine
mvn -DskipTests package
$env:OIDC_CLIENT_SECRET = "bpmn_local_dev_only"
java -jar target\bpmn-engine-0.1.0.jar
```

Deploy the definition once, as an administrator:

```powershell
Invoke-RestMethod -Method Post -Headers (H $adm) `
  -Uri http://localhost:3000/api/v1/processes/deploy/standard
```

It is validated before it reaches the engine. A user task with no candidate
group, no step code or no form is refused, because each of those produces a
task that sits in the engine forever and appears in nobody's inbox.

Now open a case and watch the loop:

```powershell
$c = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/cases -Headers (H $sup) `
  -ContentType application/json -Body (@{
    taxpayerId=2; taxTypeCode='CIT'; assessmentYear='2019'
    assessmentType='DESK'; triggerPath='RISK' } | ConvertTo-Json)

# The process that is coordinating it
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/processes/cases/$($c.id)" -Headers (H $sup)

# The engine has already called back to retrieve evidence
(Invoke-RestMethod -Uri "http://localhost:3000/api/v1/cases/$($c.id)" -Headers (H $sup)).statusCode
# DATA_READY

# And raised a task, visible only to the roles that may claim it
Invoke-RestMethod -Uri http://localhost:3000/api/v1/workflow/tasks -Headers (H $ass)
```

The assessor sees the preparation task; the reviewer, approver and supervisor
see nothing, because it is not theirs.

### How the engine authenticates

As itself. `tas-bpmn` is a Keycloak service account holding one role, `SYSTEM`,
granted exactly two routes: evidence refresh and transition. A shared secret
that skipped authorisation would have been simpler and would have given the
engine unlimited access to every endpoint on the strength of a string in a
config file.

### If the engine is down

Cases still open, and are worked by hand. Every orchestration call is attempted
and logged; none of them can fail a case. The reconciliation job reports the
divergence.

---

## 20. The taxpayer portal

Sign in as `acme-finance` / `password` and open **My Tax Affairs**.

The portal shows what a taxpayer is entitled to: the assessments served on
them, the notices, what they owe, and the route to object. It does not show the
calculation trace, the adjustments or the evidence — those are the officer's
working papers.

```powershell
$tp = Get-Token acme-finance

Invoke-RestMethod -Uri http://localhost:3000/api/v1/portal/me -Headers (H $tp)
Invoke-RestMethod -Uri http://localhost:3000/api/v1/portal/cases -Headers (H $tp)
```

A taxpayer never supplies the identifier that decides whose data they see.
Every query resolves their own taxpayer from the recorded authority and filters
on it in SQL, so a guessed case id returns nothing:

```powershell
# Another taxpayer's case -> 404, indistinguishable from one that does not exist
Invoke-RestMethod -Uri http://localhost:3000/api/v1/portal/cases/4 -Headers (H $tp)

# Officer surfaces -> 403
Invoke-RestMethod -Uri http://localhost:3000/api/v1/cases -Headers (H $tp)
```

Authority is dated, not permanent. An agent whose engagement ends stops seeing
the taxpayer's affairs that day, and the record of when they could see them
survives.

---

## 21. Security, recovery and acceptance

### The boundary probe

```powershell
node scripts/security/boundary-probe.js
```

Forty-four checks against the running stack: anonymous access, forged tokens,
cross-taxpayer access by identifier, role separation, SQL metacharacters in
path parameters and in the `sort` parameter, mass assignment, JSON numbers
where money is expected, export scope, security headers, and both rate limits.

Three of those checks exist because they once failed: a taxpayer could read
their own unserved assessment through one endpoint but not another; an internal
report was readable by any internal role; and a non-numeric case id returned a
500 carrying a database message.

It is not a penetration test. It automates the checks a tester runs first, so a
change that quietly opens one fails the build instead of surviving to the
engagement.

### The DR rehearsal

```powershell
bash scripts/dr/rehearse.sh
```

Fingerprints the live data, backs it up, restores into a scratch database,
fingerprints that, and compares. The fingerprint is about meaning rather than
row counts — sums, notice content hashes, event totals — because matching
counts only prove a restore copied rows, not that it copied the right ones.

It reports the recovery time every run, and states plainly what it did **not**
cover: object storage, the Keycloak realm, and Flowable's in-flight timers.

### UAT

`docs/uat/` is a prepared pack: environment setup, logins per role, twelve
scenarios written as outcomes rather than clicks, a findings sheet with agreed
severities, and honest expectations about what will come back.

Running it needs tax officers. The most valuable scenario in the pack is the
taxpayer one, run with somebody who does not work in tax.

---

## 22. The dashboard

Open **Dashboard**. It is the first screen an officer opens, and every figure
on it is theirs: an assessor sees their own cases, a supervisor the team's.
The same scope predicate as the register decides, from the same function, so
the two cannot disagree.

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/v1/dashboard/summary   -Headers (H $sup)
Invoke-RestMethod -Uri http://localhost:3000/api/v1/dashboard/workload  -Headers (H $sup)
Invoke-RestMethod -Uri http://localhost:3000/api/v1/dashboard/throughput -Headers (H $sup)
Invoke-RestMethod -Uri http://localhost:3000/api/v1/dashboard/sla       -Headers (H $sup)
```

Compare the assessor's figures with the supervisor's:

```powershell
(Invoke-RestMethod -Uri http://localhost:3000/api/v1/dashboard/summary -Headers (H $ass)).open_cases
(Invoke-RestMethod -Uri http://localhost:3000/api/v1/dashboard/summary -Headers (H $sup)).open_cases
```

Both are right. The screen says which it is showing, because a dashboard whose
scope is invisible is one people quote in meetings without knowing what it
counted.

### What the screen refuses to do

**Assessed and collected are two tiles, never one.** Assessed is what was
determined; collected is what arrived. A single "revenue" figure blurring them
is the fastest route to a wrong number in a briefing.

**Charts approximate; the tiles are exact.** A bar cannot draw a
`NUMERIC(20,4)`, so every chart has the exact strings beside it, and the one
place a monetary string becomes a number for plotting is named `toSeries` and
confined to presentation (ADR-007).

**Service levels and statutory deadlines are separate panels.** An SLA is a
promise the authority made to itself. A statutory deadline is one the law made
for it, and missing that can make an assessment unenforceable.

---

## 23. Configurable registers and export

### The columns are data

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/v1/grids/ASSESSMENT_REGISTER -Headers (H $sup)
```

The register asks the server which columns to draw. To move the limitation
date onto every officer's screen, edit the row:

```sql
UPDATE platform.grid_definition
   SET column_defs = jsonb_set(column_defs, '{9,exportOnly}', 'false')
 WHERE grid_key = 'ASSESSMENT_REGISTER';
```

Reload the register: the column is there. No release, no rebuild.

A definition names a **column key**, never SQL. The server maps the key to an
expression through a fixed allowlist, so a definition can only choose from
what the code already offers. That is what makes it safe to edit register
configuration from an administration screen at all.

### The full list contract

```powershell
# page, pageSize, sort and filters (plan 6.8)
Invoke-RestMethod -Headers (H $sup) `
  -Uri "http://localhost:3000/api/v1/cases?pageSize=10&sort=netPayable:desc&search=Acme"
```

A sort naming anything outside the allowlist is refused with 400 and the list
of what is sortable:

```powershell
Invoke-RestMethod -Headers (H $sup) `
  -Uri "http://localhost:3000/api/v1/cases?sort=(select+1):asc"
# 400: '(select 1)' is not a column this register can be sorted by.
```

### Export

```powershell
$job = Invoke-RestMethod -Method Post -Headers (H $sup) -ContentType application/json `
  -Uri http://localhost:3000/api/v1/exports `
  -Body (@{ gridKey='ASSESSMENT_REGISTER'; format='XLSX'; filters=@{ taxTypeCode='CIT' } } | ConvertTo-Json)

$job.status      # READY for a small register; QUEUED for a large one
Invoke-WebRequest -Headers (H $sup) -OutFile register.xlsx `
  -Uri "http://localhost:3000/api/v1/exports/$($job.uuid)/download"
```

Three things to look at in the file:

- **The export-only columns are there** — TIN, jurisdiction, limitation date —
  and they are not on screen. A queue an officer works all day stays readable;
  a file an auditor reconciles carries the detail.
- **Amounts are text.** Excel will not sum the column without converting it.
  That is the trade: an export that ties back to the register is worth more
  than one that adds up to nearly the right number.
- **A taxpayer named `=HYPERLINK(...)` is not a formula.** Every text cell is
  neutralised with a leading apostrophe. Company names are typed by people,
  some of whom are disputing the assessment being exported.

Above five thousand rows the export is queued and the worker produces it. Try
it against the load corpus:

```powershell
npm run load:seed          # 920,003 cases
# then export with no filters -> QUEUED, and the worker picks it up within a minute
```

An export carries the scope of the officer who asked for it, so only they can
collect it. Another officer gets a 404 — the existence of somebody else's
export is not their business.

---

## 24. The process journey and the modeller

### Where a case has reached

Open a case that a process is coordinating and choose the **Journey** tab.
Green has finished, amber is waiting on somebody now, and the list beneath is
the engine's own event stream.

```powershell
Invoke-RestMethod -Headers (H $sup) `
  -Uri "http://localhost:3000/api/v1/processes/cases/$($c.id)/journey"
```

A case with no process answers `coordinated: false` and says so on screen.
That is not a fault: a case opened while the engine was unreachable is worked
by hand, and the reconciliation report lists cases in that position.

### Why the diagram exists at all

The shipped definition is authored **without** diagram interchange, because it
is reviewed as text and coordinates in a diff are noise. A viewer cannot draw
without them, so the API lays out a definition that has none before returning
it — one implementation, on the server, so the journey screen and the
modeller cannot arrange the same process differently. The stored XML is
untouched.

### The modeller

**Process Modeller**, for an administrator. It loads the deployed definition,
or a file, or starts blank.

The property panel offers exactly what a definition here may contain: the
roles that may claim a user task, its step code and form, and the
`apiInvoker` fields on a service task. Not because bpmn-js cannot offer more,
but because everything else is refused at deployment, and a panel that invites
an author to fill in a field the deploy button rejects is a panel that teaches
the wrong thing.

Try breaking it deliberately:

1. Select **Prepare the assessment** and clear every role.
2. Press **Validate**.

```
It would be refused:
  prepareAssessment — a user task must name at least one candidate group
```

Click the element id in the message and the diagram selects it. The same
validator runs on deploy, so the panel never becomes a second opinion about
what is publishable.

**Deploy** sends it to the engine and records it in `workflow.process_definition`.
Cases opened afterwards are coordinated by the new version; cases already
running keep the one they started under, which is why the journey screen can
still draw a case from last month correctly.

---

## 25. Accessibility, drafts and multi-factor sign-in

### Keyboard

Tab into the page: the first stop is **Skip to content**. On a case, the tab
list is a single tab stop — arrow keys move between the nine tabs, Home and
End jump to the ends. Without that, reaching the Timeline tab means pressing
Tab nine times on every case.

Every focused control has a visible ring. It is a deliberate style rather than
the browser default, which is easily lost against a card.

### Drafts

Start typing an adjustment narrative, then close the tab and come back. The
text is there, with a line saying where it came from and a button to discard
it. Nothing was sent: a draft is held in the browser, because posting every
keystroke would fill the case record with half-formed adjustments nobody meant
to record.

It is honest about its limits, on screen: this browser, this machine. Turn the
network off and the form says so rather than letting an officer submit into a
void.

### The adjustment form is configuration

The form in the workbench is the published `TA-06-ADJUSTMENT` template,
rendered by the same DynaForms renderer the form screens use (plan 18.2). Its
reason codes are options in the template, and its button comes from the
template's button group.

```powershell
Invoke-RestMethod -Headers (H $ass) `
  -Uri http://localhost:3000/api/v1/forms/templates/TA-06-ADJUSTMENT/published
```

Add a reason code in the form builder, publish, reload the tab: it is in the
dropdown. That is the rule the plan states most forcefully, and the reason V1
is quoted in the margin — a hand-written assessment form becomes a component
nobody can configure for the next jurisdiction.

### Multi-factor sign-in

The realm carries a conditional one-time-code flow, `officer-mfa-browser`, and
every officer account holds the `MFA_REQUIRED` role. It is **not bound** as the
browser flow, deliberately: binding it makes every officer enrol an
authenticator on next sign-in, which would stop this walkthrough dead and
break the scripted checks.

To switch it on in an environment:

```
Keycloak admin -> Authentication -> Flows -> officer-mfa-browser
  -> Action -> Bind flow -> Browser flow
```

A taxpayer signing in to the portal is unaffected: the condition is the role,
and `TA_TAXPAYER` does not hold it.

---

## Troubleshooting

**`password authentication failed for user "tas"`**
Your native PostgreSQL on 5432 is shadowing the container. Confirm `DB_PORT=5433` in `.env` and that `docker port tas-postgres` shows `5433`.

**Keycloak returns a Tomcat 404, or a token request fails**
Something else owns the port. Check with `netstat -ano | Select-String ":8085"`. Your local Tomcat holds 8081, which is why Keycloak is on 8085.

**Every route returns 403, even as `admin-tax`**
The authorisation catalogue could not load, or the route is not registered. Check the API log: `ROUTE_NOT_REGISTERED` means a missing permission row; `Authorization catalogue unavailable` means Redis or Postgres is unreachable. Both deny by design.

**`MissingConfigurationError: Required configuration DB_PASSWORD is not set`**
`Copy-Item .env.example .env`. Configuration is validated at boot on purpose.

**Token rejected: `missing required "aud" claim`**
The realm import includes an audience mapper adding `tas-api` to the token. If you recreated the realm by hand, add it back — do not work around it by disabling audience validation.

**`EADDRINUSE :::3000`**
A previous API process survived. See the `taskkill` recipe in §11.

**Smoke test reports every check as `got 0`**
An older copy of the script using `-SkipHttpErrorCheck`, which is PowerShell 7+ only. The current script handles Windows PowerShell 5.1.

**The web app shows "The API could not be reached"**
The API is not running on port 3000. Start it first, then reload the browser.

**Port 4200 is already in use**
Check with `netstat -ano | Select-String ":4200"`. The listener may be on IPv6
(`[::1]:4200`), which an IPv4-only search misses.

**`ERROR: type "citext" does not exist` during `npm run db:migrate`**

The migration is running against the **wrong PostgreSQL**. `citext`,
`pgcrypto` and `btree_gist` are created by `deploy/docker/init-db.sql`, which
runs once when the container's data volume is first created. A native
PostgreSQL on your machine never ran it, so the extensions are absent and the
first migration that needs one fails.

Check where the migration is actually pointing:

```bash
grep -E "^DB_(HOST|PORT|USER|NAME)" .env     # what sequelize-cli will use
netstat -ano | grep -E ":5432|:5433"          # who is listening
docker port tas-postgres                      # the container's host port
```

`DB_PORT=5432` with `DB_USER=postgres` means a native install; the project's
container is `5433` / `tas`. Fix `.env` to match `.env.example`:

```
DB_HOST=localhost
DB_PORT=5433
DB_USER=tas
DB_PASSWORD=tas_local_dev_only
DB_NAME=tax_assessment
```

Confirm the extensions exist before re-running:

```bash
docker exec tas-postgres psql -U tas -d tax_assessment -c "select extname from pg_extension order by 1"
# btree_gist, citext, pgcrypto, plpgsql
```

Then `npm run db:migrate` reports "No migrations were executed" if the
container was already up to date, which is the answer you want.

**Clean up the stray half-migration.** A run against the wrong server leaves
schemas and a `platform.sequelize_meta` row behind in _that_ database. It is
harmless but it will confuse the next diagnosis, and it is not in a database
this project manages — check before dropping anything:

```bash
psql -h localhost -p 5432 -U postgres -d tax_assessment \
  -c "select table_schema, count(*) from information_schema.tables
       where table_schema in ('platform','forms','workflow','tax') group by 1"
```

The same class of failure with a different symptom — `password authentication
failed for user "tas"` — is the entry above. Both are one cause: a native
service shadowing the container.

**Migrations ran but a table is missing**
Tables live in `platform`, `forms`, `workflow` or `tax` — never `public`. Use `\dt tax.*` in psql.
