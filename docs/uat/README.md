# User acceptance testing

A pack for running UAT with real tax officers.

**This document does not constitute UAT.** UAT is officers using the system to
do their own work and telling you where it is wrong. Nobody on the build side
can perform it, and no automated suite substitutes for it — the defects UAT
finds are the ones where the software does exactly what was asked and the ask
was wrong.

What this pack does is make the session productive: a prepared environment,
scenarios covering the paths that matter, and a way to record findings that
distinguishes a bug from a misunderstanding from a genuine requirement gap.

---

## Before the session

```powershell
npm run dev:up
npm run db:migrate
npm run db:seed
npm run start:api
npm run start:worker     # so deadline sweeps run during the session
npm run start:web
```

Deploy the process definition once, as `admin-tax`:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/processes/deploy/standard -Headers (H $adm)
```

Confirm the environment is sound before anybody arrives:

```powershell
node scripts/security/boundary-probe.js      # expect 44/44
bash scripts/dr/rehearse.sh                  # expect MATCH
```

### Logins

| Role              | User                | Password   |
| ----------------- | ------------------- | ---------- |
| Assessor          | `assessor`          | `password` |
| Reviewer          | `reviewer`          | `password` |
| Approver          | `approver`          | `password` |
| Supervisor        | `supervisor`        | `password` |
| Notice issuer     | `notice-issuer`     | `password` |
| Objection officer | `objection-officer` | `password` |
| Appeals officer   | `appeals-officer`   | `password` |
| Administrator     | `admin-tax`         | `password` |
| **Taxpayer**      | `acme-finance`      | `password` |

Officer accounts hold `MFA_REQUIRED`, but the conditional one-time-code flow is
not bound in the local realm — see `docs/running-locally.md` §25. If the
session is to cover signing in with a second factor, bind it before anybody
arrives, and allow ten minutes for enrolment.

Give each participant the login matching the job they actually do. An assessor
testing the approval screen tells you nothing about whether approvers can
approve.

---

## Scenarios

Each is written as an outcome, not as clicks. If a participant cannot work out
how to do it, **that is the finding** — write down where they got stuck rather
than telling them the answer.

### 1. Open and prepare an assessment — _assessor_

> A risk report says Acme Trading Ltd understated revenue for 2024. Open a case,
> pull in what the authority already holds, record the adjustment, and work out
> what they owe.

Watch for: whether the evidence panel makes it clear what was retrieved and what
failed; whether the adjustment form asks for what an officer would naturally
write; whether the calculation trace is checkable by hand.

### 2. Review somebody else's work — _reviewer_

> An assessment has been submitted to you. Decide whether the figures are
> supportable, and either accept it or send it back.

Watch for: whether the reviewer can see the basis of every adjustment without
leaving the screen, and whether returning it communicates what needs changing.

### 3. Approve — _approver_

> An assessment has been routed to you. Approve it, or refuse it.

Watch for: whether the approver understands why _they_ got it and not somebody
else, and whether the amount at stake is obvious.

### 4. Issue and serve a notice — _notice issuer_

> The assessment is final. Produce the notice, check it, and serve it by post.

Watch for: whether the wording is acceptable to send to a member of the public;
whether "treated as received" is understood; whether the verify function means
anything to the user.

### 5. Handle an objection — _objection officer_

> The taxpayer disagrees. Decide whether to hear the objection, then decide it.

Watch for: whether the distinction between admissibility and the merits is
clear; whether the officer feels able to admit a late objection; whether the
reasons field gets a real answer or one word.

### 6. See it as the taxpayer — _taxpayer_

> You have received a demand you think is wrong. Find out what you owe and why,
> and object.

**This is the most valuable scenario in the pack.** Run it with somebody who
does not work in tax. Watch for: whether they can find the amount, the
deadline, and the objection route without help.

### 7. Run a selection campaign — _supervisor_

> Decide who to assess for 2024, and open the cases.

Watch for: whether the reasons a taxpayer was selected are convincing enough to
act on.

### 8. Simulate a rate change — _administrator_

> The rate is changing next year. Find out what that would have done.

Watch for: whether the movement figures are enough to approve a publication.

### 9. Start the day — _any officer_

> Sign in and work out what needs your attention today.

The dashboard scopes everything to the person looking at it, so run this with
two participants of different roles and compare what they saw. Watch for:
whether they understood that the figures are theirs and not the office's;
whether "assessed" and "collected" were read as two numbers or one; whether the
overdue-deadline tile was noticed at all.

### 10. Take the register away — _supervisor_

> You have a meeting about corporation tax cases this year. Take the list with
> you.

Watch for: whether they found the export; whether the file had the columns they
needed and not the ones they did not; whether anybody tried to sum the amount
column in Excel and was surprised that it is text. That last one is a real
finding — record what they expected.

### 11. Find out why a case is stuck — _supervisor_

> A case has not moved for three weeks. Work out what it is waiting for.

Watch for: whether the Journey tab is where they look; whether the diagram
helps or whether they go straight to the step list underneath it; whether
"waiting on somebody" is clear from the screen or has to be inferred.

### 12. Change the process — _administrator_

> Assessments over a threshold should be seen by a second reviewer. Change the
> process to do that.

The most demanding scenario in the pack for an administrator, and the one most
likely to produce a **Question** rather than a defect. Watch for: whether the
property panel's vocabulary matches how they describe the change; whether the
validator's refusal messages are actionable; whether they understood that
cases already running keep the old definition.

---

## Recording findings

Use one line per finding, with this shape:

| #   | Scenario | Who | What happened | What they expected | Severity |
| --- | -------- | --- | ------------- | ------------------ | -------- |

Severity, agreed in advance:

- **Blocker** — the work cannot be done at all
- **Major** — the work can be done, but wrongly, slowly, or unsafely
- **Minor** — friction, wording, layout
- **Question** — the software may be right and the participant may be wrong;
  needs a policy answer, not a code change

Keep _Question_ separate and take it seriously. A tax officer saying "that
penalty looks wrong" is either a defect or a rule nobody has confirmed, and the
open caveat on every figure in this system means it is quite often the second.

---

## What to expect to find

Honest expectations, so the session is not judged against the wrong bar:

- **Wording**, everywhere. The screens were written by a developer reasoning
  about the domain, not by somebody who has issued a notice.
- **Missing shortcuts.** Officers work a queue all day and will want bulk
  actions, keyboard paths, and defaults this build does not have.
- **Tax content.** Every rate, penalty, interest figure and deadline in the
  system is illustrative and has not been through an SME. Expect challenges,
  and record them as _Question_ rather than defects.
- **The portal** to attract the most comment per minute, because it is the only
  screen tested by somebody outside the domain.
- **Register columns.** Officers will want different ones. That is a
  configuration row rather than a change request, so record the columns they
  ask for and note that the answer is a `grid_definition` edit.
- **The export being text, not numbers.** Somebody will try to sum it. The
  reason is that an exact decimal does not survive a spreadsheet's own number
  type, and the export has to tie back to the notice. Record how strongly they
  object; a totals row in the file may be the right answer.

## What this pack cannot tell you

Whether the system is usable at volume. A participant working three cases in a
morning learns nothing about working two hundred a week, and the scenarios here
are deliberately individual. Sustained-load usability needs a pilot, not a
session.
