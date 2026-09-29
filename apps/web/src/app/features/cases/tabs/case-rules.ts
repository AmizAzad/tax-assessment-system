import { HttpErrorResponse } from '@angular/common/http';
import {
  CaseStatus,
  UNDER_DECISION_CASE_STATUSES,
  areFiguresLocked,
  statusesWithAction,
} from '@tas/contracts';

/**
 * Which statuses each workbench control is accepted in.
 *
 * Plan reference: V2 sections 10.2, 18.2.
 *
 * A control the server will refuse is not offered. Where the rule is a
 * transition, it is read off the state machine in `@tas/contracts`, the table
 * the server validates against. Where it is a service guard that is not a
 * transition — refreshing evidence, issuing a notice — the list mirrors that
 * guard and names it, because the service is the rule and this is a courtesy
 * to the officer. Each list is here once so that a changed guard has one
 * place to follow it.
 */

/** Mirrors `assertNotFrozen` in the API's `evidence.service.ts`. */
const EVIDENCE_OPEN: readonly string[] = [
  CaseStatus.INITIATED,
  CaseStatus.DATA_READY,
  CaseStatus.ASSIGNED,
  CaseStatus.IN_PREPARATION,
  CaseStatus.AWAITING_TAXPAYER_RESPONSE,
];

/** Mirrors `canIssueNoticeFrom` in the API's `notice.service.ts`. */
const NOTICE_ISSUABLE: readonly string[] = [
  CaseStatus.FINALISED,
  CaseStatus.NOTICE_GENERATED,
  CaseStatus.NOTICE_SERVED,
  CaseStatus.AWAITING_TAXPAYER_RESPONSE,
  CaseStatus.UNDER_OBJECTION,
  CaseStatus.UNDER_APPEAL,
];

/**
 * Mirrors `canObjectFrom` in the API's `objection.service.ts`.
 *
 * Wider than the state machine's `FILE_OBJECTION` row by NOTICE_SERVED, which
 * the service accepts and the engine moves on from within the same second.
 */
const OBJECTION_FILEABLE: readonly string[] = [
  CaseStatus.NOTICE_SERVED,
  CaseStatus.AWAITING_TAXPAYER_RESPONSE,
];

/**
 * `IN_PLACE_STATUSES` and `SUCCESSOR_STATUSES` in the API's
 * `reassessment.service.ts`: a dispute outcome reassesses in place, a
 * finished case is succeeded by a new one.
 */
const REASSESSABLE: readonly string[] = [
  CaseStatus.OBJECTION_ALLOWED,
  CaseStatus.OBJECTION_PARTLY_ALLOWED,
  CaseStatus.APPEAL_VARIED,
  CaseStatus.APPEAL_REMANDED,
  CaseStatus.CLOSED,
  CaseStatus.SETTLED,
  CaseStatus.WRITTEN_OFF,
];

export function canRetrieveEvidenceFrom(status: string): boolean {
  return EVIDENCE_OPEN.includes(status);
}

/** Mirrors `areFiguresLocked`, which the adjustment and calculation services both apply. */
export function canRework(status: string): boolean {
  return status !== '' && !areFiguresLocked(status as CaseStatus);
}

/** A reviewer or approver is deciding on the figures, so a change goes back via rework. */
export function isUnderDecision(status: string): boolean {
  return UNDER_DECISION_CASE_STATUSES.includes(status as CaseStatus);
}

export function canIssueNoticeFrom(status: string): boolean {
  return NOTICE_ISSUABLE.includes(status);
}

export function canObjectFrom(status: string): boolean {
  return OBJECTION_FILEABLE.includes(status);
}

export function canAppealFrom(status: string): boolean {
  return (statusesWithAction('FILE_APPEAL') as readonly string[]).includes(status);
}

export function canReassessFrom(status: string): boolean {
  return REASSESSABLE.includes(status);
}

export function canCloseFrom(status: string): boolean {
  return (statusesWithAction('CLOSE') as readonly string[]).includes(status);
}

/**
 * Whether a closure record can exist.
 *
 * Only a CLOSED case has one, so asking on any other status is a request
 * whose answer is known to be "not found".
 */
export function mayHaveClosure(status: string): boolean {
  return status === CaseStatus.CLOSED;
}

/** "Nothing here yet", as opposed to a failure worth showing. */
export function isNotFound(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.status === 404;
}
