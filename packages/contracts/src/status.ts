/**
 * Case and liability status codes.
 *
 * Plan reference: V2 section 16.
 *
 * Two independent axes that must never be conflated: a case can be CLOSED
 * while its liability is PARTLY_PAID. They are separate columns and separate
 * enums for exactly that reason.
 *
 * Status codes are stable identifiers, never display text. Every one resolves
 * through a display key (`ta.status.<CODE>`) so the same code set serves every
 * jurisdiction with different labels.
 */

export enum CaseStatus {
  // Initial
  INITIATED = 'INITIATED',
  DATA_READY = 'DATA_READY',
  ASSIGNED = 'ASSIGNED',

  // Working
  IN_PREPARATION = 'IN_PREPARATION',
  AWAITING_TAXPAYER = 'AWAITING_TAXPAYER',
  CALCULATED = 'CALCULATED',

  // Review
  UNDER_REVIEW = 'UNDER_REVIEW',
  REVIEW_RETURNED = 'REVIEW_RETURNED',
  REVIEWED = 'REVIEWED',

  // Approval
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',

  // Issue
  FINALISED = 'FINALISED',
  NOTICE_GENERATED = 'NOTICE_GENERATED',
  NOTICE_SERVED = 'NOTICE_SERVED',
  AWAITING_TAXPAYER_RESPONSE = 'AWAITING_TAXPAYER_RESPONSE',

  // Dispute
  UNDER_OBJECTION = 'UNDER_OBJECTION',
  OBJECTION_ALLOWED = 'OBJECTION_ALLOWED',
  OBJECTION_PARTLY_ALLOWED = 'OBJECTION_PARTLY_ALLOWED',
  OBJECTION_REJECTED = 'OBJECTION_REJECTED',

  // Appeal
  UNDER_APPEAL = 'UNDER_APPEAL',
  APPEAL_UPHELD = 'APPEAL_UPHELD',
  APPEAL_VARIED = 'APPEAL_VARIED',
  APPEAL_SET_ASIDE = 'APPEAL_SET_ASIDE',
  APPEAL_REMANDED = 'APPEAL_REMANDED',

  // Reassessment
  REASSESSMENT_INITIATED = 'REASSESSMENT_INITIATED',

  // Terminal
  SETTLED = 'SETTLED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
  TIME_BARRED = 'TIME_BARRED',
  WRITTEN_OFF = 'WRITTEN_OFF',

  // Exception
  FINALISATION_FAILED = 'FINALISATION_FAILED',
  NOTICE_FAILED = 'NOTICE_FAILED',
}

/** Statuses from which no transition is permitted except by creating a successor case. */
export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = Object.freeze([
  CaseStatus.CLOSED,
  CaseStatus.CANCELLED,
  CaseStatus.TIME_BARRED,
  CaseStatus.WRITTEN_OFF,
]);

/** Statuses after which the case is locked for editing. */
export const FROZEN_CASE_STATUSES: readonly CaseStatus[] = Object.freeze([
  CaseStatus.FINALISED,
  CaseStatus.NOTICE_GENERATED,
  CaseStatus.NOTICE_SERVED,
  CaseStatus.AWAITING_TAXPAYER_RESPONSE,
  ...TERMINAL_CASE_STATUSES,
]);

export function isTerminalStatus(status: CaseStatus): boolean {
  return TERMINAL_CASE_STATUSES.includes(status);
}

export function isFrozenStatus(status: CaseStatus): boolean {
  return FROZEN_CASE_STATUSES.includes(status);
}

/**
 * Statuses in which somebody other than the preparer is deciding on the figures.
 *
 * Adjusting or recalculating here would change the figure after the reviewer
 * or approver had looked at it, and finalising would then serve a liability
 * nobody but its author ever saw. Evidence already freezes from the same
 * point. A figure that has to change goes back through Return for rework,
 * which puts it in front of the reviewer again.
 */
export const UNDER_DECISION_CASE_STATUSES: readonly CaseStatus[] = Object.freeze([
  CaseStatus.UNDER_REVIEW,
  CaseStatus.REVIEWED,
  CaseStatus.PENDING_APPROVAL,
  CaseStatus.APPROVED,
]);

/** Whether adjustments and calculation are closed: under decision, or frozen. */
export function areFiguresLocked(status: CaseStatus): boolean {
  return UNDER_DECISION_CASE_STATUSES.includes(status) || isFrozenStatus(status);
}

/** The liability axis. Independent of case status. */
export enum LiabilityStatus {
  UNPAID = 'UNPAID',
  PARTLY_PAID = 'PARTLY_PAID',
  PAID = 'PAID',
  REFUNDED = 'REFUNDED',
  WRITTEN_OFF = 'WRITTEN_OFF',
  /** Collection suspended pending an objection or appeal outcome. */
  STAYED = 'STAYED',
}
