import { Injectable, inject } from '@angular/core';
import type { FormDefinition } from '@tas/dynaforms-core';
import { ApiService } from './api.service';
import type {
  Adjustment,
  BpmnValidation,
  DashboardSummary,
  DashboardWorkload,
  ExportJob,
  GridDefinition,
  GridPage,
  ProcessJourney,
  SlaPosition,
  ThroughputPoint,
  AppealSummary,
  AssessmentCase,
  CalculationDelta,
  CaseSearchResult,
  ClosureRecord,
  DepositPosition,
  EvidenceSnapshot,
  LineageEntry,
  Notice,
  ObjectionDetail,
  ObjectionSummary,
  RecordedDeadline,
  ServiceAttempt,
  SlaClock,
  StoredCalculation,
  TimelineEntry,
} from './domain';

/**
 * Every call the assessment screens make.
 *
 * Plan reference: V2 section 14.5.
 *
 * ## Why one service rather than one per screen
 *
 * The screens are views onto a single case, and splitting the calls across a
 * dozen feature services would mean a dozen places that each know a little of
 * the API's shape. Keeping them together makes the surface the front end
 * depends on readable in one file, which is what matters when the API changes.
 *
 * ## What is deliberately absent
 *
 * Nothing here computes. There is no client-side total, no recomputed balance,
 * no "days remaining" worked out in the browser. Every figure and every
 * statutory date is asked for and displayed as returned (ADR-006).
 */
@Injectable({ providedIn: 'root' })
export class AssessmentService {
  private readonly api = inject(ApiService);

  // ------------------------------------------------------------------ cases

  searchCases(filters: {
    status?: string;
    taxTypeCode?: string;
    taxpayerId?: number;
    page?: number;
    pageSize?: number;
  }): Promise<CaseSearchResult> {
    const params: Record<string, string | number> = {};
    if (filters.status) params['status'] = filters.status;
    if (filters.taxTypeCode) params['taxTypeCode'] = filters.taxTypeCode;
    if (filters.taxpayerId !== undefined) params['taxpayerId'] = filters.taxpayerId;
    if (filters.page !== undefined) params['page'] = filters.page;
    if (filters.pageSize !== undefined) params['pageSize'] = filters.pageSize;
    return this.api.get<CaseSearchResult>('/cases', params);
  }

  getCase(id: number): Promise<AssessmentCase> {
    return this.api.get<AssessmentCase>(`/cases/${id}`);
  }

  createCase(body: {
    taxpayerId: number;
    taxTypeCode: string;
    assessmentYear: string;
    assessmentType: string;
    triggerPath: string;
    limitationDate?: string;
  }): Promise<AssessmentCase> {
    return this.api.post<AssessmentCase>('/cases', body);
  }

  timeline(id: number): Promise<readonly TimelineEntry[]> {
    return this.api.get<readonly TimelineEntry[]>(`/cases/${id}/timeline`);
  }

  /**
   * Apply a lifecycle action.
   *
   * One endpoint for every action, because the transition table decides what
   * is permitted. A per-action method here would duplicate that table in the
   * browser and let the two drift.
   */
  transition(
    id: number,
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<AssessmentCase> {
    return this.api.post<AssessmentCase>(`/cases/${id}/transition`, { action, payload });
  }

  // ------------------------------------------------------- evidence & items

  refreshEvidence(id: number): Promise<{
    dataReady: boolean;
    statusCode: string;
    itemsWritten: number;
    providers: readonly {
      providerCode: string;
      status: string;
      itemCount: number;
      failureReason?: string;
      mandatory: boolean;
    }[];
  }> {
    return this.api.post(`/cases/${id}/evidence/refresh`);
  }

  evidence(id: number): Promise<EvidenceSnapshot> {
    return this.api.get<EvidenceSnapshot>(`/cases/${id}/evidence`);
  }

  adjustments(id: number): Promise<readonly Adjustment[]> {
    return this.api.get<readonly Adjustment[]>(`/cases/${id}/adjustments`);
  }

  addAdjustment(
    id: number,
    body: {
      adjustmentType: string;
      reasonCode: string;
      amount: string;
      direction: 'ADD' | 'DEDUCT';
      narrative?: string;
    },
  ): Promise<Adjustment> {
    return this.api.post<Adjustment>(`/cases/${id}/adjustments`, body);
  }

  // ------------------------------------------------------------ calculation

  calculate(id: number): Promise<StoredCalculation> {
    return this.api.post<StoredCalculation>(`/cases/${id}/calculate`);
  }

  currentCalculation(id: number): Promise<StoredCalculation | null> {
    return this.api.get<StoredCalculation | null>(`/cases/${id}/calculation`);
  }

  calculationHistory(id: number): Promise<readonly StoredCalculation[]> {
    return this.api.get<readonly StoredCalculation[]>(`/cases/${id}/calculation/history`);
  }

  delta(id: number): Promise<CalculationDelta> {
    return this.api.get<CalculationDelta>(`/cases/${id}/calculation/delta`);
  }

  // --------------------------------------------------- deadlines & approval

  recordedDeadlines(id: number): Promise<readonly RecordedDeadline[]> {
    return this.api.get<readonly RecordedDeadline[]>(`/cases/${id}/deadlines/recorded`);
  }

  slaClocks(id: number): Promise<readonly SlaClock[]> {
    return this.api.get<readonly SlaClock[]>(`/cases/${id}/sla`);
  }

  routeForApproval(id: number): Promise<{
    statusCode: string;
    requiredRoleCode: string;
    requiredApprovals: number;
    derivation: string;
  }> {
    return this.api.post(`/cases/${id}/route-approval`);
  }

  finalise(id: number): Promise<{ statusCode: string; lossesConsumed: string }> {
    return this.api.post(`/cases/${id}/finalise`);
  }

  approvalThresholds(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.api.get('/approval-thresholds', jurisdiction ? { jurisdiction } : undefined);
  }

  // ---------------------------------------------------------------- notices

  notices(id: number): Promise<readonly Notice[]> {
    return this.api.get<readonly Notice[]>(`/cases/${id}/notices`);
  }

  generateNotice(id: number, noticeType: string, languageCode?: string): Promise<Notice> {
    return this.api.post<Notice>(`/cases/${id}/notices`, { noticeType, languageCode });
  }

  notice(uuid: string): Promise<Notice> {
    return this.api.get<Notice>(`/notices/${uuid}`);
  }

  verifyNotice(uuid: string): Promise<{
    noticeNumber: string;
    intact: boolean;
    storedHash: string;
    recomputedHash: string;
  }> {
    return this.api.get(`/notices/${uuid}/verify`);
  }

  serveNotice(
    uuid: string,
    body: { channel: string; addressee: string; proofReference?: string },
  ): Promise<ServiceAttempt> {
    return this.api.post<ServiceAttempt>(`/notices/${uuid}/serve`, body);
  }

  recordServiceOutcome(
    uuid: string,
    serviceId: number,
    body: { status: string; failureReason?: string; proofReference?: string },
  ): Promise<ServiceAttempt> {
    return this.api.post<ServiceAttempt>(`/notices/${uuid}/service/${serviceId}/outcome`, body);
  }

  noticeTemplates(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.api.get('/notice-templates', jurisdiction ? { jurisdiction } : undefined);
  }

  // --------------------------------------------------------------- disputes

  objections(id: number): Promise<readonly ObjectionSummary[]> {
    return this.api.get<readonly ObjectionSummary[]>(`/cases/${id}/objections`);
  }

  objection(uuid: string): Promise<ObjectionDetail> {
    return this.api.get<ObjectionDetail>(`/objections/${uuid}`);
  }

  fileObjection(
    id: number,
    body: {
      groundsSummary: string;
      grounds: { groundCode: string; detail?: string; disputedAmount?: string }[];
      requestedRelief?: string;
      filedChannel?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/cases/${id}/objections`, body);
  }

  decideAdmissibility(
    uuid: string,
    body: { admissibility: string; reason: string },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/objections/${uuid}/admissibility`, body);
  }

  recordOpinion(
    uuid: string,
    body: { opinion: string; reasoning?: string },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/objections/${uuid}/opinions`, body);
  }

  decideObjection(
    uuid: string,
    body: { decision: string; reason: string },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/objections/${uuid}/decision`, body);
  }

  depositPosition(uuid: string): Promise<DepositPosition> {
    return this.api.get<DepositPosition>(`/objections/${uuid}/deposit`);
  }

  recordDeposit(uuid: string, amount: string): Promise<DepositPosition> {
    return this.api.post<DepositPosition>(`/objections/${uuid}/deposit`, { amount });
  }

  appeals(id: number): Promise<readonly AppealSummary[]> {
    return this.api.get<readonly AppealSummary[]>(`/cases/${id}/appeals`);
  }

  appeal(uuid: string): Promise<Record<string, unknown>> {
    return this.api.get(`/appeals/${uuid}`);
  }

  fileAppeal(
    id: number,
    body: {
      forumCode: string;
      groundsSummary: string;
      disputedAmount?: string;
      externalReference?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/cases/${id}/appeals`, body);
  }

  listHearing(
    uuid: string,
    body: { scheduledFor: string; venue?: string; representative?: string },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/appeals/${uuid}/hearings`, body);
  }

  recordAppealOutcome(
    uuid: string,
    body: { outcome: string; reason: string; externalReference?: string },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/appeals/${uuid}/outcome`, body);
  }

  implementAppeal(uuid: string, note: string): Promise<Record<string, unknown>> {
    return this.api.post(`/appeals/${uuid}/implement`, { note });
  }

  disputeRegister(filters: {
    status?: string;
    overdueImplementation?: boolean;
  }): Promise<readonly Record<string, unknown>[]> {
    const params: Record<string, string> = {};
    if (filters.status) params['status'] = filters.status;
    if (filters.overdueImplementation) params['overdueImplementation'] = 'true';
    return this.api.get('/disputes', params);
  }

  // ----------------------------------------------- reassessment and closure

  reassess(
    id: number,
    body: { grounds: string; limitationOverrideReason?: string },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/cases/${id}/reassess`, body);
  }

  reassessments(id: number): Promise<readonly Record<string, unknown>[]> {
    return this.api.get(`/cases/${id}/reassessments`);
  }

  lineage(id: number): Promise<readonly LineageEntry[]> {
    return this.api.get<readonly LineageEntry[]>(`/cases/${id}/lineage`);
  }

  close(
    id: number,
    body: { reasonCode: string; narrative?: string; retentionClass?: string },
  ): Promise<ClosureRecord> {
    return this.api.post<ClosureRecord>(`/cases/${id}/close`, body);
  }

  closure(id: number): Promise<ClosureRecord> {
    return this.api.get<ClosureRecord>(`/cases/${id}/closure`);
  }

  setLegalHold(id: number, hold: boolean, reason: string): Promise<Record<string, unknown>> {
    return this.api.post(`/cases/${id}/legal-hold`, { hold, reason });
  }

  // --------------------------------------------------------------- accounts

  account(taxpayerId: number): Promise<{
    taxpayerId: number;
    entries: readonly Record<string, unknown>[];
    losses: readonly Record<string, unknown>[];
  }> {
    return this.api.get(`/taxpayers/${taxpayerId}/account`);
  }

  recordAccountEntry(
    taxpayerId: number,
    body: {
      entryType: string;
      taxTypeCode: string;
      assessmentYear: string;
      amount: string;
      currencyCode: string;
      valueDate: string;
      creditCode?: string;
      sourceReference?: string;
      narrative?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.api.post(`/taxpayers/${taxpayerId}/account`, body);
  }

  // ------------------------------------------------- selection and reports

  riskRules(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.api.get('/risk-rules', jurisdiction ? { jurisdiction } : undefined);
  }

  selectionRuns(): Promise<readonly Record<string, unknown>[]> {
    return this.api.get('/selection/runs');
  }

  runSelection(body: {
    jurisdictionCode: string;
    taxTypeCode: string;
    assessmentYear: string;
    scoreThreshold?: number;
  }): Promise<{
    runId: number;
    threshold: number;
    candidates: readonly {
      taxpayerId: number;
      tin: string;
      name: string;
      totalScore: number;
      selected: boolean;
      suppressedReason?: string;
      matchedRules: readonly { ruleCode: string; weight: number; detail: string }[];
    }[];
  }> {
    return this.api.post('/selection/runs', body);
  }

  selectionCandidates(runId: number): Promise<readonly Record<string, unknown>[]> {
    return this.api.get(`/selection/runs/${runId}`);
  }

  openCasesFromRun(
    runId: number,
    maxCases: number,
  ): Promise<{ opened: number; skipped: number; caseNumbers: readonly string[] }> {
    return this.api.post(`/selection/runs/${runId}/open-cases`, { maxCases });
  }

  ruleSets(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.api.get('/rule-sets', jurisdiction ? { jurisdiction } : undefined);
  }

  simulate(ruleSetId: number, assessmentYear?: string): Promise<Record<string, unknown>> {
    return this.api.post(
      `/rule-sets/${ruleSetId}/simulate${assessmentYear ? `?assessmentYear=${assessmentYear}` : ''}`,
    );
  }

  report(
    name: string,
    params?: Record<string, string>,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.api.get(`/reports/${name}`, params);
  }

  reconciliation(): Promise<Record<string, readonly Record<string, unknown>[]>> {
    return this.api.get('/reports/reconciliation');
  }

  // -------------------------------------------------------------- registers

  /**
   * The columns of a register.
   *
   * Asked for rather than assumed. A deployment that adds the limitation date
   * to the register changes a configuration row, and this call is how the
   * screen finds out (plan 6.8).
   */
  gridDefinition(gridKey: string): Promise<GridDefinition> {
    return this.api.get<GridDefinition>(`/grids/${gridKey}`);
  }

  /** A page of the assessment register, with the full list contract. */
  register(query: {
    status?: string;
    taxTypeCode?: string;
    jurisdiction?: string;
    assessmentYear?: string;
    search?: string;
    openedFrom?: string;
    openedTo?: string;
    sort?: string;
    page?: number;
    pageSize?: number;
  }): Promise<GridPage> {
    const params: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        params[key] = value as string | number;
      }
    }
    return this.api.get<GridPage>('/cases', params);
  }

  requestExport(
    gridKey: string,
    format: 'CSV' | 'XLSX',
    filters: Record<string, string | number>,
    sort?: string,
  ): Promise<ExportJob> {
    return this.api.post<ExportJob>('/exports', { gridKey, format, filters, sort });
  }

  exportStatus(uuid: string): Promise<ExportJob> {
    return this.api.get<ExportJob>(`/exports/${uuid}`);
  }

  myExports(): Promise<readonly ExportJob[]> {
    return this.api.get<readonly ExportJob[]>('/exports');
  }

  downloadExport(uuid: string): Promise<{ blob: Blob; filename: string }> {
    return this.api.getFile(`/exports/${uuid}/download`);
  }

  // -------------------------------------------------------------- dashboard

  dashboardSummary(): Promise<DashboardSummary> {
    return this.api.get<DashboardSummary>('/dashboard/summary');
  }

  dashboardWorkload(): Promise<DashboardWorkload> {
    return this.api.get<DashboardWorkload>('/dashboard/workload');
  }

  dashboardThroughput(months = 12): Promise<readonly ThroughputPoint[]> {
    return this.api.get<readonly ThroughputPoint[]>('/dashboard/throughput', { months });
  }

  dashboardSla(): Promise<SlaPosition> {
    return this.api.get<SlaPosition>('/dashboard/sla');
  }

  // ---------------------------------------------------------------- process

  journey(caseId: number): Promise<ProcessJourney> {
    return this.api.get<ProcessJourney>(`/processes/cases/${caseId}/journey`);
  }

  processDefinition(
    workflowCode: string,
  ): Promise<{ workflowCode: string; version: number; status: string; bpmnXml: string }> {
    return this.api.get(`/processes/definitions/${workflowCode}`);
  }

  validateProcess(name: string, bpmnXml: string): Promise<BpmnValidation> {
    return this.api.post<BpmnValidation>('/processes/validate', { name, bpmnXml });
  }

  deployProcess(
    name: string,
    bpmnXml: string,
  ): Promise<{ deploymentId: string; processDefinitionKey: string; version: number }> {
    return this.api.post('/processes/deploy', { name, bpmnXml });
  }

  // ------------------------------------------------------------------ forms

  /**
   * The published version of a form template.
   *
   * The workbench renders configuration rather than markup (plan 18.2), so a
   * screen asks for the template by code and draws whatever comes back.
   */
  publishedTemplate(
    code: string,
    year?: string,
  ): Promise<{ id: number; templateCode: string; version: number; definition: FormDefinition }> {
    return this.api.get(`/forms/templates/${code}/published`, year ? { year } : undefined);
  }
}
