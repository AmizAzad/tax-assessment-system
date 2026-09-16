import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DocumentModule } from '../platform/document/document.module';
import { NotificationModule } from '../platform/notification/notification.module';
import { FormsModule } from '../forms/forms.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ApprovalController } from './approval/approval.controller';
import { ApprovalService } from './approval/approval.service';
import { AdjustmentService } from './case/adjustment.service';
import { CaseController } from './case/case.controller';
import { CaseService } from './case/case.service';
import { RegisterGridSource } from './case/register.source';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { CalculationExceptionFilter } from './calculation/calculation-exception.filter';
import { CalculationController } from './calculation/calculation.controller';
import { CalculationService } from './calculation/calculation.service';
import { RuleSetService } from './calculation/rule-set.service';
import { AppealService } from './dispute/appeal.service';
import { DisputeController } from './dispute/dispute.controller';
import { ObjectionService } from './dispute/objection.service';
import { DeadlineScheduler } from './deadline/deadline.scheduler';
import { DeadlineService } from './deadline/deadline.service';
import { SlaService } from './deadline/sla.service';
import { AccountEvidenceProvider } from './evidence/account.provider';
import { AccountService } from './evidence/account.service';
import { EvidenceController } from './evidence/evidence.controller';
import { EVIDENCE_PROVIDERS, type EvidenceProvider } from './evidence/evidence-provider';
import { EvidenceService } from './evidence/evidence.service';
import { FilingEvidenceProvider } from './evidence/filing.provider';
import { ClosureService } from './lifecycle/closure.service';
import { LifecycleController } from './lifecycle/lifecycle.controller';
import { ReassessmentService } from './lifecycle/reassessment.service';
import { SettlementService } from './lifecycle/settlement.service';
import { NoticeController } from './notice/notice.controller';
import { PublicNoticeController } from './notice/public-notice.controller';
import { ReportingController } from './reporting/reporting.controller';
import { RiskRuleController, SelectionController } from './selection/selection.controller';
import { SelectionService } from './selection/selection.service';
import { PortalController } from './portal/portal.controller';
import { PortalService } from './portal/portal.service';
import { ProcessController } from './workflow/process.controller';
import { ProcessOrchestrationService } from './workflow/process-orchestration.service';
import { SimulatorService } from './calculation/simulator.service';
import { DepositService } from './dispute/deposit.service';
import { ReportingService } from './reporting/reporting.service';
import { NoticeService } from './notice/notice.service';
import { ServiceDeliveryService } from './notice/service-delivery.service';

/**
 * The tax assessment domain.
 *
 * Phases 2 to 4: the case lifecycle, evidence, adjustments, and the
 * authoritative calculation.
 *
 * Nothing imports from this module. It may reach into platform, forms and
 * workflow; the reverse would couple the platform to the domain, and the
 * import-boundary lint rule enforces that (plan 14.2).
 */
@Module({
  imports: [FormsModule, DocumentModule, NotificationModule, WorkflowModule],
  controllers: [
    CaseController,
    CalculationController,
    EvidenceController,
    ApprovalController,
    NoticeController,
    PublicNoticeController,
    DisputeController,
    LifecycleController,
    ReportingController,
    SelectionController,
    RiskRuleController,
    ProcessController,
    PortalController,
    DashboardController,
  ],
  providers: [
    CaseService,
    // Publishes the assessment register into the platform's grid registry at
    // boot, so the grid and export machinery stays domain-agnostic (plan 14.2).
    RegisterGridSource,
    DashboardService,
    AdjustmentService,
    CalculationService,
    RuleSetService,
    EvidenceService,
    AccountService,
    DeadlineService,
    SlaService,
    DeadlineScheduler,
    ApprovalService,
    NoticeService,
    ServiceDeliveryService,
    ObjectionService,
    AppealService,
    ReassessmentService,
    ClosureService,
    SettlementService,
    ReportingService,
    SelectionService,
    ProcessOrchestrationService,
    PortalService,
    SimulatorService,
    DepositService,
    FilingEvidenceProvider,
    AccountEvidenceProvider,
    {
      /**
       * Registered here rather than in main.ts, because the error it maps is
       * owned by this module and the platform may not import it (plan 14.2).
       */
      provide: APP_FILTER,
      useClass: CalculationExceptionFilter,
    },
    {
      /**
       * The provider list, assembled here rather than discovered.
       *
       * Explicit registration means the set of sources a case is assessed on
       * is readable in one place. A decorator-scanned registry would make
       * "which sources ran" depend on which files happened to be imported,
       * which is not a property that should be implicit when the answer
       * determines whether an assessment is complete.
       */
      provide: EVIDENCE_PROVIDERS,
      useFactory: (filing: FilingEvidenceProvider, account: AccountEvidenceProvider) =>
        [filing, account] as readonly EvidenceProvider[],
      inject: [FilingEvidenceProvider, AccountEvidenceProvider],
    },
  ],
  exports: [
    CaseService,
    CalculationService,
    RuleSetService,
    EvidenceService,
    DeadlineService,
    SlaService,
    ApprovalService,
    NoticeService,
  ],
})
export class TaxAssessmentModule {}
