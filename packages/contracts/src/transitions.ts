import { ActionCode, CaseEventType } from './enums';
import { RoleCode } from './roles';
import { CaseStatus, isTerminalStatus } from './status';

/**
 * The case state machine, as data.
 *
 * Plan reference: V2 section 10.2 (transition table).
 *
 * This exists so that the lifecycle is one reviewable artefact rather than a
 * set of `if` statements scattered across services. The BPMN process is what
 * *drives* transitions at runtime; this table is what the domain validates
 * them against, so an out-of-order transition caused by a replayed webhook or
 * a hand-written API call is rejected rather than silently applied.
 */
export interface CaseTransition {
  readonly from: CaseStatus | null;
  readonly action: ActionCode | string;
  readonly to: CaseStatus;
  /** Roles permitted to perform this transition. SYSTEM means a service task. */
  readonly actors: readonly RoleCode[];
  readonly event: CaseEventType;
}

const T = (
  from: CaseStatus | null,
  action: ActionCode | string,
  to: CaseStatus,
  actors: readonly RoleCode[],
  event: CaseEventType,
): CaseTransition => Object.freeze({ from, action, to, actors, event });

export const CASE_TRANSITIONS: readonly CaseTransition[] = Object.freeze([
  T(
    null,
    'INITIATE',
    CaseStatus.INITIATED,
    [RoleCode.SUPERVISOR, RoleCode.SYSTEM, RoleCode.ADMIN],
    CaseEventType.CASE_INITIATED,
  ),
  T(
    CaseStatus.INITIATED,
    'RETRIEVE_DATA',
    CaseStatus.DATA_READY,
    [RoleCode.SYSTEM],
    CaseEventType.EVIDENCE_SNAPSHOT_CREATED,
  ),
  T(
    CaseStatus.INITIATED,
    ActionCode.CANCEL,
    CaseStatus.CANCELLED,
    [RoleCode.SUPERVISOR],
    CaseEventType.CASE_CANCELLED,
  ),
  T(
    CaseStatus.DATA_READY,
    ActionCode.ASSIGN,
    CaseStatus.ASSIGNED,
    [RoleCode.SUPERVISOR],
    CaseEventType.CASE_ASSIGNED,
  ),
  T(
    CaseStatus.ASSIGNED,
    'START',
    CaseStatus.IN_PREPARATION,
    [RoleCode.ASSESSOR],
    CaseEventType.PREPARATION_STARTED,
  ),
  T(
    CaseStatus.IN_PREPARATION,
    ActionCode.REQUEST_INFO,
    CaseStatus.AWAITING_TAXPAYER,
    [RoleCode.ASSESSOR],
    CaseEventType.INFO_REQUESTED,
  ),
  T(
    CaseStatus.AWAITING_TAXPAYER,
    ActionCode.RESPOND,
    CaseStatus.IN_PREPARATION,
    [RoleCode.TAXPAYER],
    CaseEventType.INFO_RECEIVED,
  ),
  T(
    CaseStatus.AWAITING_TAXPAYER,
    'TIMEOUT',
    CaseStatus.IN_PREPARATION,
    [RoleCode.SYSTEM],
    CaseEventType.INFO_TIMEOUT,
  ),
  T(
    CaseStatus.IN_PREPARATION,
    'CALCULATE',
    CaseStatus.CALCULATED,
    [RoleCode.ASSESSOR, RoleCode.SYSTEM],
    CaseEventType.CALCULATION_RUN,
  ),
  T(
    CaseStatus.CALCULATED,
    ActionCode.SUBMIT,
    CaseStatus.UNDER_REVIEW,
    [RoleCode.ASSESSOR],
    CaseEventType.SUBMITTED_FOR_REVIEW,
  ),
  T(
    CaseStatus.UNDER_REVIEW,
    ActionCode.RETURN,
    CaseStatus.REVIEW_RETURNED,
    [RoleCode.REVIEWER],
    CaseEventType.REVIEW_RETURNED,
  ),
  T(
    CaseStatus.REVIEW_RETURNED,
    'START',
    CaseStatus.IN_PREPARATION,
    [RoleCode.ASSESSOR],
    CaseEventType.PREPARATION_STARTED,
  ),
  T(
    CaseStatus.UNDER_REVIEW,
    ActionCode.ACCEPT,
    CaseStatus.REVIEWED,
    [RoleCode.REVIEWER],
    CaseEventType.REVIEW_ACCEPTED,
  ),
  T(
    CaseStatus.REVIEWED,
    'ROUTE_APPROVAL',
    CaseStatus.PENDING_APPROVAL,
    [RoleCode.SYSTEM],
    CaseEventType.ROUTED_FOR_APPROVAL,
  ),
  T(
    CaseStatus.PENDING_APPROVAL,
    ActionCode.APPROVE,
    CaseStatus.APPROVED,
    [RoleCode.APPROVER_L1, RoleCode.APPROVER_L2, RoleCode.APPROVER_L3],
    CaseEventType.APPROVED,
  ),
  T(
    CaseStatus.PENDING_APPROVAL,
    ActionCode.REJECT,
    CaseStatus.REJECTED,
    [RoleCode.APPROVER_L1, RoleCode.APPROVER_L2, RoleCode.APPROVER_L3],
    CaseEventType.REJECTED,
  ),
  T(
    CaseStatus.REJECTED,
    'START',
    CaseStatus.IN_PREPARATION,
    [RoleCode.ASSESSOR],
    CaseEventType.PREPARATION_STARTED,
  ),
  T(
    CaseStatus.APPROVED,
    'FINALISE',
    CaseStatus.FINALISED,
    [RoleCode.SYSTEM],
    CaseEventType.FINALISED,
  ),
  T(
    CaseStatus.FINALISED,
    'GENERATE_NOTICE',
    CaseStatus.NOTICE_GENERATED,
    [RoleCode.SYSTEM],
    CaseEventType.NOTICE_GENERATED,
  ),
  T(
    CaseStatus.NOTICE_GENERATED,
    ActionCode.SERVED,
    CaseStatus.NOTICE_SERVED,
    [RoleCode.SYSTEM, RoleCode.NOTICE_ISSUER],
    CaseEventType.NOTICE_SERVED,
  ),
  T(
    CaseStatus.NOTICE_SERVED,
    'START_RESPONSE_WINDOW',
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    [RoleCode.SYSTEM],
    CaseEventType.RESPONSE_WINDOW_OPENED,
  ),
  T(
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    'PAYMENT_SETTLED',
    CaseStatus.SETTLED,
    [RoleCode.SYSTEM],
    CaseEventType.SETTLED,
  ),
  /**
   * An objection is the taxpayer's act, but not always their keystroke.
   *
   * Objections arrive by post and over a counter in every jurisdiction, and an
   * officer records them. Restricting this to the taxpayer role would mean the
   * platform could only accept objections from people who use the portal,
   * which would exclude a large part of the population from a statutory right.
   *
   * The officer roles here are recording a filing, not making one: who filed
   * is captured on the objection itself.
   */
  T(
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    'FILE_OBJECTION',
    CaseStatus.UNDER_OBJECTION,
    [RoleCode.TAXPAYER, RoleCode.OBJECTION_OFFICER, RoleCode.SUPERVISOR],
    CaseEventType.OBJECTION_FILED,
  ),
  T(
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    'WINDOW_LAPSED',
    CaseStatus.CLOSED,
    [RoleCode.SYSTEM],
    CaseEventType.WINDOW_LAPSED,
  ),
  T(
    CaseStatus.UNDER_OBJECTION,
    'DECIDE_ALLOWED',
    CaseStatus.OBJECTION_ALLOWED,
    [RoleCode.OBJECTION_OFFICER],
    CaseEventType.OBJECTION_DECIDED,
  ),
  T(
    CaseStatus.UNDER_OBJECTION,
    'DECIDE_PARTLY_ALLOWED',
    CaseStatus.OBJECTION_PARTLY_ALLOWED,
    [RoleCode.OBJECTION_OFFICER],
    CaseEventType.OBJECTION_DECIDED,
  ),
  T(
    CaseStatus.UNDER_OBJECTION,
    'DECIDE_REJECTED',
    CaseStatus.OBJECTION_REJECTED,
    [RoleCode.OBJECTION_OFFICER],
    CaseEventType.OBJECTION_DECIDED,
  ),
  T(
    CaseStatus.OBJECTION_ALLOWED,
    'REASSESS',
    CaseStatus.REASSESSMENT_INITIATED,
    [RoleCode.SYSTEM],
    CaseEventType.REASSESSMENT_TRIGGERED,
  ),
  T(
    CaseStatus.OBJECTION_PARTLY_ALLOWED,
    'REASSESS',
    CaseStatus.REASSESSMENT_INITIATED,
    [RoleCode.SYSTEM],
    CaseEventType.REASSESSMENT_TRIGGERED,
  ),
  /** Recorded by an officer where the appeal was lodged on paper, as above. */
  T(
    CaseStatus.OBJECTION_REJECTED,
    'FILE_APPEAL',
    CaseStatus.UNDER_APPEAL,
    [RoleCode.TAXPAYER, RoleCode.APPEALS_OFFICER, RoleCode.SUPERVISOR],
    CaseEventType.APPEAL_FILED,
  ),
  T(
    CaseStatus.OBJECTION_REJECTED,
    ActionCode.CLOSE,
    CaseStatus.CLOSED,
    [RoleCode.SYSTEM, RoleCode.SUPERVISOR],
    CaseEventType.CASE_CLOSED,
  ),
  T(
    CaseStatus.UNDER_APPEAL,
    'RECORD_UPHELD',
    CaseStatus.APPEAL_UPHELD,
    [RoleCode.APPEALS_OFFICER],
    CaseEventType.APPEAL_DECIDED,
  ),
  T(
    CaseStatus.UNDER_APPEAL,
    'RECORD_VARIED',
    CaseStatus.APPEAL_VARIED,
    [RoleCode.APPEALS_OFFICER],
    CaseEventType.APPEAL_DECIDED,
  ),
  T(
    CaseStatus.UNDER_APPEAL,
    'RECORD_SET_ASIDE',
    CaseStatus.APPEAL_SET_ASIDE,
    [RoleCode.APPEALS_OFFICER],
    CaseEventType.APPEAL_DECIDED,
  ),
  T(
    CaseStatus.UNDER_APPEAL,
    'RECORD_REMANDED',
    CaseStatus.APPEAL_REMANDED,
    [RoleCode.APPEALS_OFFICER],
    CaseEventType.APPEAL_DECIDED,
  ),
  T(
    CaseStatus.APPEAL_VARIED,
    'REASSESS',
    CaseStatus.REASSESSMENT_INITIATED,
    [RoleCode.SYSTEM],
    CaseEventType.REASSESSMENT_TRIGGERED,
  ),
  T(
    CaseStatus.APPEAL_REMANDED,
    'REASSESS',
    CaseStatus.REASSESSMENT_INITIATED,
    [RoleCode.SYSTEM],
    CaseEventType.REASSESSMENT_TRIGGERED,
  ),
  T(
    CaseStatus.APPEAL_SET_ASIDE,
    ActionCode.CLOSE,
    CaseStatus.CLOSED,
    [RoleCode.SYSTEM, RoleCode.SUPERVISOR],
    CaseEventType.CASE_CLOSED,
  ),
  T(
    CaseStatus.APPEAL_UPHELD,
    'PAYMENT_SETTLED',
    CaseStatus.SETTLED,
    [RoleCode.SYSTEM],
    CaseEventType.SETTLED,
  ),
  T(
    CaseStatus.REASSESSMENT_INITIATED,
    'START',
    CaseStatus.IN_PREPARATION,
    [RoleCode.ASSESSOR],
    CaseEventType.REASSESSMENT_STARTED,
  ),
  T(
    CaseStatus.SETTLED,
    ActionCode.CLOSE,
    CaseStatus.CLOSED,
    [RoleCode.SUPERVISOR, RoleCode.SYSTEM],
    CaseEventType.CASE_CLOSED,
  ),

  // --------------------------------------------------------------------------
  // Terminal outcomes other than CLOSED.
  //
  // Plan gap, resolved here: V2 section 16.1 lists TIME_BARRED and WRITTEN_OFF
  // as terminal statuses and section 8.2 stage 14 names them as closure
  // outcomes, but the section 10.2 transition table never produces either. The
  // structural reachability test in transitions.spec.ts caught it. Raised as an
  // open item against the plan; the transitions below are the minimum needed to
  // make both statuses reachable and must be confirmed by the tax SME.
  // --------------------------------------------------------------------------
  T(
    CaseStatus.INITIATED,
    'LIMITATION_EXPIRED',
    CaseStatus.TIME_BARRED,
    [RoleCode.SYSTEM],
    CaseEventType.DEADLINE_BREACHED,
  ),
  T(
    CaseStatus.IN_PREPARATION,
    'LIMITATION_EXPIRED',
    CaseStatus.TIME_BARRED,
    [RoleCode.SYSTEM],
    CaseEventType.DEADLINE_BREACHED,
  ),
  T(
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    'WRITE_OFF',
    CaseStatus.WRITTEN_OFF,
    [RoleCode.SUPERVISOR],
    CaseEventType.CASE_CLOSED,
  ),
]);

export interface TransitionLookup {
  readonly from: CaseStatus | null;
  readonly action: ActionCode | string;
}

export function findTransition({ from, action }: TransitionLookup): CaseTransition | undefined {
  return CASE_TRANSITIONS.find(
    (transition) => transition.from === from && transition.action === action,
  );
}

export function isTransitionPermitted(lookup: TransitionLookup): boolean {
  return findTransition(lookup) !== undefined;
}

/** Every action available from a status, for building a UI action bar. */
export function availableActions(from: CaseStatus): readonly (ActionCode | string)[] {
  return CASE_TRANSITIONS.filter((t) => t.from === from).map((t) => t.action);
}

/** Every status reachable in one step. */
export function reachableStatuses(from: CaseStatus): readonly CaseStatus[] {
  return CASE_TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: CaseStatus | null,
    readonly action: ActionCode | string,
  ) {
    super(
      `No transition defined from ${from ?? '(start)'} on action ${action}. ` +
        `Permitted actions: ${from === null ? 'INITIATE' : availableActions(from).join(', ') || '(none — terminal)'}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export class UnauthorisedTransitionError extends Error {
  constructor(
    readonly action: ActionCode | string,
    readonly heldRoles: readonly string[],
    readonly requiredRoles: readonly string[],
  ) {
    super(
      `Action ${action} requires one of [${requiredRoles.join(', ')}]; ` +
        `caller holds [${heldRoles.join(', ')}].`,
    );
    this.name = 'UnauthorisedTransitionError';
  }
}

/**
 * Resolve and authorise a transition in one call.
 *
 * Throws rather than returning a result object because an unpermitted
 * transition is a defect or an attack, never an expected branch.
 */
export function assertTransition(
  from: CaseStatus | null,
  action: ActionCode | string,
  heldRoles: readonly string[],
): CaseTransition {
  if (from !== null && isTerminalStatus(from)) {
    throw new InvalidTransitionError(from, action);
  }
  const transition = findTransition({ from, action });
  if (transition === undefined) {
    throw new InvalidTransitionError(from, action);
  }
  const permitted = transition.actors.some((role) => heldRoles.includes(role));
  if (!permitted) {
    throw new UnauthorisedTransitionError(action, heldRoles, transition.actors);
  }
  return transition;
}
