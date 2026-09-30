/**
 * The shapes the API returns.
 *
 * Plan reference: V2 section 14.5.
 *
 * ## Amounts are strings here too
 *
 * Every monetary field is `string`, matching the API, and the browser never
 * parses one into a `number`. The governing rule is that nothing determining a
 * legal figure executes in a browser (ADR-006): the front end displays what the
 * server computed and does no arithmetic of its own.
 *
 * `formatAmount` below is presentation only. It groups digits and it does not
 * round, because a figure that changed on the way to the screen is a figure
 * nobody can reconcile.
 */

export interface AssessmentCase {
  readonly id: number;
  readonly uuid: string;
  readonly caseNumber: string;
  readonly taxpayerId: number;
  readonly tin: string;
  readonly taxpayerName: string;
  readonly taxTypeCode: string;
  readonly jurisdictionCode: string;
  readonly assessmentYear: string;
  readonly assessmentType: string;
  readonly triggerPath: string;
  readonly statusCode: string;
  readonly liabilityStatus: string;
  readonly currencyCode: string;
  readonly assessedBase: string | null;
  readonly netPayable: string | null;
  readonly limitationDate: string | null;
  readonly openedAt: string;
}

export interface CaseSearchResult {
  readonly rows: readonly AssessmentCase[];
  readonly total: number;
}

export interface TimelineEntry {
  readonly eventType: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly occurredAt: string;
  /** Who acted. Null for a step no person took, such as a timer firing. */
  readonly actorUsername?: string | null;
  /** The capacity they acted in, which is not always a role they hold now. */
  readonly actorRoleCode?: string | null;
  readonly payload?: Record<string, unknown> | null;
}

/** One configured code in a jurisdiction's catalogue. */
export interface MasterItem {
  readonly itemCode: string;
  readonly displayKey: string;
  readonly sortOrder: number;
}

export interface MasterGroup {
  readonly groupCode: string;
  readonly jurisdictionCode?: string;
  readonly displayKey: string;
  readonly items: readonly MasterItem[];
}

export interface Adjustment {
  readonly id: number;
  readonly adjustmentType: string;
  readonly reasonCode: string;
  readonly amount: string;
  readonly direction: 'ADD' | 'DEDUCT';
  readonly narrative: string | null;
  readonly status: string;
}

export interface TraceEntry {
  readonly sequence: number;
  readonly step: string;
  readonly descriptionKey: string;
  readonly expression: string;
  readonly output: string;
  readonly ruleReference: string | null;
}

export interface StoredCalculation {
  readonly id: number;
  readonly version: number;
  readonly ruleSetCode: string;
  readonly ruleSetVersion: number;
  readonly declaredBase: string;
  readonly totalAdjustments: string;
  readonly assessedBase: string;
  readonly lossesSetOff: string;
  readonly taxableBase: string;
  readonly taxBeforeCredits: string;
  readonly totalCredits: string;
  readonly taxAfterCredits: string;
  readonly penaltyAmount: string;
  readonly interestAmount: string;
  readonly totalPayable: string;
  readonly netPayableOrRefundable: string;
  readonly currencyCode: string;
  readonly calculatedAt: string;
  readonly trace: readonly TraceEntry[];
}

export interface CalculationDelta {
  readonly from: number | null;
  readonly to: number;
  readonly currencyCode: string;
  readonly netMovement: string;
  readonly direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
  readonly lines: readonly {
    label: string;
    previous: string;
    revised: string;
    movement: string;
  }[];
}

export interface EvidenceSnapshot {
  readonly sources: readonly {
    source_system: string;
    payload_hash: string;
    retrieved_at: string;
    response_json: Record<string, unknown> | null;
  }[];
  readonly items: readonly {
    concept_code: string;
    item_label_key: string | null;
    declared_amount: string;
    assessed_amount: string | null;
    source: string;
    sequence: number;
  }[];
}

export interface RecordedDeadline {
  readonly deadline_type: string;
  readonly anchor_event: string;
  readonly anchor_at: string;
  readonly due_at: string;
  readonly status: string;
  readonly warned_at: string | null;
  readonly breached_at: string | null;
}

export interface SlaClock {
  readonly slaCode: string;
  readonly stageCode: string | null;
  readonly startedAt: string;
  readonly targetAt: string;
  readonly completedAt: string | null;
  readonly status: string;
  readonly daysRemaining: number | null;
}

export interface Notice {
  readonly id: number;
  readonly uuid: string;
  readonly noticeNumber: string;
  readonly noticeType: string;
  readonly version: number;
  readonly languageCode: string;
  readonly status: string;
  readonly contentHash: string;
  readonly title: string;
  readonly body: string;
  readonly documentUuid: string | null;
  readonly issuedAt: string | null;
  readonly deemedServedOn: string | null;
  readonly serviceAttempts?: readonly ServiceAttempt[];
}

export interface ServiceAttempt {
  readonly id: number;
  readonly channel: string;
  readonly addressee: string;
  readonly status: string;
  readonly dispatchedAt: string | null;
  readonly deliveredAt: string | null;
  readonly deemedServedOn: string | null;
  readonly proofReference: string | null;
  readonly failureReason: string | null;
}

export interface ObjectionSummary {
  readonly uuid: string;
  readonly objection_number: string;
  readonly filed_on: string;
  readonly was_in_time: boolean;
  readonly days_late: number;
  readonly admissibility: string;
  readonly status: string;
  readonly decision: string | null;
  readonly decided_on: string | null;
}

export interface ObjectionDetail extends ObjectionSummary {
  readonly grounds_summary: string;
  readonly admissibility_reason: string | null;
  readonly decision_reason: string | null;
  readonly deadline_on: string | null;
  readonly grounds: readonly {
    id: number;
    ground_code: string;
    detail: string | null;
    disputed_amount: string | null;
    outcome: string | null;
  }[];
  readonly opinions: readonly {
    member_user_id: number;
    username: string | null;
    opinion: string;
    reasoning: string | null;
  }[];
}

export interface DepositPosition {
  readonly required: boolean;
  readonly amount: string | null;
  readonly currencyCode: string;
  readonly paid: string;
  readonly outstanding: string | null;
  readonly staysCollection: boolean;
  readonly derivation: string;
}

export interface AppealSummary {
  readonly uuid: string;
  readonly appeal_number: string;
  readonly forum_code: string;
  readonly external_reference: string | null;
  readonly filed_on: string;
  readonly was_in_time: boolean;
  readonly status: string;
  readonly outcome: string | null;
  readonly decided_on: string | null;
  readonly implemented_at: string | null;
}

export interface ClosureRecord {
  readonly reason_code: string;
  readonly narrative: string | null;
  readonly final_assessed_amount: string | null;
  readonly final_paid_amount: string | null;
  readonly final_balance: string | null;
  readonly currency_code: string | null;
  readonly closed_at: string;
  readonly auto_closed: boolean;
  readonly retention_class: string;
  readonly retain_until: string | null;
  readonly legal_hold: boolean;
  readonly legal_hold_reason: string | null;
}

export interface LineageEntry {
  readonly id: number;
  readonly case_number: string;
  readonly status_code: string;
  readonly assessment_type: string;
  readonly assessment_year: string;
  readonly predecessor_case_id: number | null;
  readonly net_payable: string | null;
  readonly opened_at: string;
}

/**
 * Group the digits of a decimal string without changing it.
 *
 * String in, string out. Never `Number(...)`: the value may exceed what a
 * double represents exactly, and a register that silently rounded a large
 * assessment on the way to the screen would be unreconcilable against the
 * notice that quotes it.
 */
export function formatAmount(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction] = unsigned.split('.');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Two places is the presentation convention across every screen; the stored
  // value keeps its four.
  const decimals = (fraction ?? '').padEnd(2, '0').slice(0, 2);

  return `${negative ? '-' : ''}${grouped}.${decimals}`;
}

export function isNegativeAmount(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith('-');
}

/**
 * Which visual weight a status carries.
 *
 * Grouped by what the status means for the person reading the register, not by
 * where it sits in the machine: anything waiting on somebody is amber, anything
 * concluded is green, anything refused or barred is red.
 */
export function statusTone(status: string): 'active' | 'waiting' | 'done' | 'stopped' | 'neutral' {
  if (
    [
      'SETTLED',
      'CLOSED',
      'FINALISED',
      'APPROVED',
      'REVIEWED',
      'NOTICE_SERVED',
      'APPEAL_UPHELD',
      'OBJECTION_REJECTED',
    ].includes(status)
  ) {
    return 'done';
  }
  if (
    [
      'CANCELLED',
      'TIME_BARRED',
      'WRITTEN_OFF',
      'REJECTED',
      'BREACHED',
      'FAILED',
      'RETURNED',
    ].includes(status)
  ) {
    return 'stopped';
  }
  if (
    [
      'AWAITING_TAXPAYER_RESPONSE',
      'AWAITING_TAXPAYER',
      'PENDING_APPROVAL',
      'UNDER_REVIEW',
      'UNDER_OBJECTION',
      'UNDER_APPEAL',
      'AWAITING_DEPOSIT',
      'REVIEW_RETURNED',
      'OPEN',
      'RUNNING',
      'PENDING',
    ].includes(status)
  ) {
    return 'waiting';
  }
  if (['IN_PREPARATION', 'CALCULATED', 'ASSIGNED', 'DATA_READY', 'INITIATED'].includes(status)) {
    return 'active';
  }
  return 'neutral';
}

/** `IN_PREPARATION` reads badly in a table header. */
export function humanise(code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return '—';
  const lower = code.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------------------------------------------------------------- registers

/**
 * A register column, as configured on the server.
 *
 * Plan reference: V2 section 6.8.
 *
 * The browser renders what it is told to render. It does not hold a list of
 * the register's columns, because the whole point of the server-side
 * definition is that a deployment can change them without a release.
 */
export interface GridColumn {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'amount' | 'date' | 'datetime' | 'status' | 'link' | 'taxpayer';
  readonly sortable?: boolean;
  readonly align?: 'start' | 'end';
  /** In the export only. Never rendered on screen. */
  readonly exportOnly?: boolean;
}

export interface GridDefinition {
  readonly gridKey: string;
  readonly columns: readonly GridColumn[];
  readonly defaultSort: string | null;
}

/** A page of a register. Rows are addressed by column key. */
export interface GridPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
}

export interface ExportJob {
  readonly uuid: string;
  readonly gridKey: string;
  readonly format: 'CSV' | 'XLSX';
  readonly status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';
  readonly rowCount: number | null;
  readonly errorDetail: string | null;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

// ---------------------------------------------------------------- dashboard

/**
 * The headline tiles.
 *
 * Every money field is a string, like everywhere else. `netAssessed` and
 * `collected` are separate fields and are never added together on screen:
 * assessed is what was determined, collected is what arrived.
 */
export interface DashboardSummary {
  readonly open_cases: number;
  readonly in_preparation: number;
  readonly awaiting_review: number;
  readonly awaiting_approval: number;
  readonly in_dispute: number;
  readonly finalised_this_month: number;
  /** Null when the caller's cases span currencies: there is no honest single total. */
  readonly net_assessed: string | null;
  readonly collected: string | null;
  readonly net_assessed_by_currency: readonly CurrencyTotal[];
  readonly collected_by_currency: readonly CurrencyTotal[];
  readonly overdue_deadlines: number;
  readonly deadlines_this_week: number;
  readonly currencies: string | null;
}

export interface CurrencyTotal {
  readonly currency: string;
  /** Decimal string, exact as summed by the database. */
  readonly amount: string;
}

export interface DashboardWorkload {
  readonly byStatus: readonly { statusCode: string; count: number }[];
  readonly byAge: readonly { band: string; count: number }[];
}

export interface ThroughputPoint {
  readonly month: string;
  readonly finalised: number;
  readonly netAssessed: string;
}

export interface SlaPosition {
  readonly service: readonly {
    slaCode: string;
    onTrack: number;
    overdue: number;
    breached: number;
    completed: number;
  }[];
  readonly statutory: readonly {
    deadlineType: string;
    caseNumber: string;
    caseId: number;
    dueAt: string;
    daysRemaining: number;
  }[];
}

// ------------------------------------------------------------------ process

/** Where a case has reached, and the diagram to draw it on. */
export interface ProcessJourney {
  readonly processInstanceId: string | null;
  readonly coordinated: boolean;
  readonly workflowCode: string | null;
  readonly bpmnXml: string | null;
  readonly completed: readonly string[];
  readonly active: readonly string[];
  readonly history: readonly {
    activityId: string | null;
    activityName: string | null;
    activityType: string | null;
    eventType: string;
    occurredAt: string;
  }[];
}

export interface BpmnProblem {
  readonly elementId?: string;
  readonly message: string;
  readonly severity?: string;
}

export interface BpmnValidation {
  readonly valid: boolean;
  readonly problems: readonly BpmnProblem[];
}
