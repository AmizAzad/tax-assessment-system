/**
 * Domain enumerations shared across the API, the worker and the SPA.
 *
 * Plan reference: V2 sections 7.2, 8, 9.2, 10.2, 12.3, 13.3.
 *
 * Anything here is a stable code, not display text. Jurisdiction-specific
 * *catalogues* (adjustment reasons, objection grounds, appeal forums) are NOT
 * here — those are rows in `platform.master_data_item`, because a table per
 * list means a migration per jurisdiction.
 */

/** How the assessment was arrived at. Plan section 7.2. */
export enum AssessmentType {
  /** Return accepted as filed; system-generated, no officer. */
  SELF = 'SELF',
  /** Automated checks plus officer confirmation. */
  DESK = 'DESK',
  /** Full field or desk audit producing adjustments. */
  AUDIT = 'AUDIT',
  /** Officer determines base from indirect evidence. */
  BEST_JUDGEMENT = 'BEST_JUDGEMENT',
  /** No return filed; base estimated. */
  NON_FILER = 'NON_FILER',
  /** Supersedes a predecessor case. */
  AMENDED = 'AMENDED',
  /** Interim liability pending final determination. */
  PROVISIONAL = 'PROVISIONAL',
}

/** Why the case was opened. Drives the initiation gateway. Plan section 8.2 stage 1. */
export enum TriggerPath {
  RISK = 'RISK',
  RANDOM = 'RANDOM',
  ANOMALY = 'ANOMALY',
  CAMPAIGN = 'CAMPAIGN',
  TAXPAYER_REQUEST = 'TAXPAYER_REQUEST',
  NON_FILER = 'NON_FILER',
  COURT_DIRECTION = 'COURT_DIRECTION',
}

/** Where an assessment item's value came from. Matters for evidential weight. */
export enum ItemSource {
  FILED = 'FILED',
  OCR = 'OCR',
  OFFICER = 'OFFICER',
  THIRD_PARTY = 'THIRD_PARTY',
}

/** Direction of an adjustment against the declared base. */
export enum AdjustmentDirection {
  ADD = 'ADD',
  DEDUCT = 'DEDUCT',
}

/** Statutory clocks the deadline engine instantiates. Plan section 13.3. */
export enum DeadlineType {
  /** Taxpayer response to an information request. */
  RESPONSE = 'RESPONSE',
  /** Window to file an objection, running from the service date. */
  OBJECTION = 'OBJECTION',
  /** Window to file an appeal, running from the objection decision service date. */
  APPEAL = 'APPEAL',
  /** The authority's own power to assess or reassess. */
  LIMITATION = 'LIMITATION',
  /** Internal service-level target, not a statutory limit. */
  SLA = 'SLA',
}

/** How a deadline offset counts days. */
export enum CalendarRule {
  CALENDAR_DAYS = 'CALENDAR_DAYS',
  WORKING_DAYS = 'WORKING_DAYS',
}

export enum DeadlineStatus {
  OPEN = 'OPEN',
  WARNED = 'WARNED',
  MET = 'MET',
  BREACHED = 'BREACHED',
  CANCELLED = 'CANCELLED',
}

/** Channels a notice can be served through. Deemed-service rules differ per channel. */
export enum ServiceChannel {
  EMAIL = 'EMAIL',
  PORTAL = 'PORTAL',
  SMS = 'SMS',
  POST = 'POST',
  HAND = 'HAND',
}

export enum DeliveryStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  BOUNCED = 'BOUNCED',
  FAILED = 'FAILED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
}

/** Outcome of a first-instance objection. */
export enum ObjectionDecision {
  ALLOWED = 'ALLOWED',
  PARTLY_ALLOWED = 'PARTLY_ALLOWED',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
}

export enum AdmissibilityStatus {
  PENDING = 'PENDING',
  ADMISSIBLE = 'ADMISSIBLE',
  INADMISSIBLE = 'INADMISSIBLE',
  CONDONED = 'CONDONED',
}

/** Outcome of an appeal to a tribunal, court or higher authority. */
export enum AppealDecision {
  UPHELD = 'UPHELD',
  VARIED = 'VARIED',
  SET_ASIDE = 'SET_ASIDE',
  REMANDED = 'REMANDED',
  DISMISSED = 'DISMISSED',
}

/** Lifecycle of a versioned, effective-dated configuration artefact. */
export enum PublicationStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

/** Kinds of rule a rule set contains. One pipeline step consumes each. Plan section 13.3. */
export enum RuleItemType {
  RATE_BAND = 'RATE_BAND',
  THRESHOLD = 'THRESHOLD',
  CREDIT_ORDER = 'CREDIT_ORDER',
  PENALTY = 'PENALTY',
  INTEREST = 'INTEREST',
  LOSS_RULE = 'LOSS_RULE',
  MIN_TAX = 'MIN_TAX',
  SURCHARGE = 'SURCHARGE',
}

/** The nine calculation pipeline steps, in order. Plan section 14.4. */
export enum CalculationStep {
  BASE_DETERMINATION = 'BASE_DETERMINATION',
  LOSS_SET_OFF = 'LOSS_SET_OFF',
  TAXABLE_BASE = 'TAXABLE_BASE',
  RATE_APPLICATION = 'RATE_APPLICATION',
  SURCHARGE = 'SURCHARGE',
  CREDITS = 'CREDITS',
  PENALTY = 'PENALTY',
  INTEREST = 'INTEREST',
  NET_POSITION = 'NET_POSITION',
}

/** Domain audit ledger event types. Plan section 10.2. */
export enum CaseEventType {
  CASE_INITIATED = 'CASE_INITIATED',
  EVIDENCE_SNAPSHOT_CREATED = 'EVIDENCE_SNAPSHOT_CREATED',
  CASE_CANCELLED = 'CASE_CANCELLED',
  CASE_ASSIGNED = 'CASE_ASSIGNED',
  PREPARATION_STARTED = 'PREPARATION_STARTED',
  INFO_REQUESTED = 'INFO_REQUESTED',
  INFO_RECEIVED = 'INFO_RECEIVED',
  INFO_TIMEOUT = 'INFO_TIMEOUT',
  ADJUSTMENT_RECORDED = 'ADJUSTMENT_RECORDED',
  CALCULATION_RUN = 'CALCULATION_RUN',
  CALCULATION_OVERRIDDEN = 'CALCULATION_OVERRIDDEN',
  SUBMITTED_FOR_REVIEW = 'SUBMITTED_FOR_REVIEW',
  REVIEW_RETURNED = 'REVIEW_RETURNED',
  REVIEW_ACCEPTED = 'REVIEW_ACCEPTED',
  ROUTED_FOR_APPROVAL = 'ROUTED_FOR_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  FINALISED = 'FINALISED',
  NOTICE_GENERATED = 'NOTICE_GENERATED',
  NOTICE_SERVED = 'NOTICE_SERVED',
  RESPONSE_WINDOW_OPENED = 'RESPONSE_WINDOW_OPENED',
  SETTLED = 'SETTLED',
  OBJECTION_FILED = 'OBJECTION_FILED',
  OBJECTION_DECIDED = 'OBJECTION_DECIDED',
  APPEAL_FILED = 'APPEAL_FILED',
  APPEAL_DECIDED = 'APPEAL_DECIDED',
  REASSESSMENT_TRIGGERED = 'REASSESSMENT_TRIGGERED',
  REASSESSMENT_STARTED = 'REASSESSMENT_STARTED',
  WINDOW_LAPSED = 'WINDOW_LAPSED',
  DEADLINE_BREACHED = 'DEADLINE_BREACHED',
  CASE_CLOSED = 'CASE_CLOSED',
}

/**
 * Workflow action codes.
 *
 * These are the contract between a form's ButtonGroup and the BPMN gateway
 * conditions: a button's name becomes the action code the gateway branches on.
 * Plan sections 5.2 and 11.4.
 */
export enum ActionCode {
  SAVE_DRAFT = 'SAVE_DRAFT',
  SUBMIT = 'SUBMIT',
  ASSIGN = 'ASSIGN',
  REQUEST_INFO = 'REQUEST_INFO',
  RESPOND = 'RESPOND',
  ACCEPT = 'ACCEPT',
  RETURN = 'RETURN',
  ESCALATE = 'ESCALATE',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  SERVED = 'SERVED',
  CLOSE = 'CLOSE',
  CANCEL = 'CANCEL',
}

/** BPMN step codes. Must match `flowable:properties/stepCode` in the process XML. */
export enum StepCode {
  TA_ASSIGN = 'TA_ASSIGN',
  TA_PREPARE = 'TA_PREPARE',
  TA_TP_INFO = 'TA_TP_INFO',
  TA_SPECIALIST = 'TA_SPECIALIST',
  TA_REVIEW = 'TA_REVIEW',
  TA_APPROVE_L1 = 'TA_APPROVE_L1',
  TA_APPROVE_L2 = 'TA_APPROVE_L2',
  TA_APPROVE_L3 = 'TA_APPROVE_L3',
  TA_SERVE_MANUAL = 'TA_SERVE_MANUAL',
  TA_CLOSE = 'TA_CLOSE',
}

/** Process definition keys. Plan section 12.1. */
export enum ProcessKey {
  MAIN = 'TAX_ASSESSMENT_MAIN',
  OBJECTION = 'TAX_ASSESSMENT_OBJECTION',
  APPEAL = 'TAX_ASSESSMENT_APPEAL',
  SELECTION = 'TAX_ASSESSMENT_SELECTION',
}
