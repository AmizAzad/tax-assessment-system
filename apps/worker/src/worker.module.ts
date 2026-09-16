import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { InfrastructureModule } from '../../api/src/infrastructure/infrastructure.module';
import { AuthorizationModule } from '../../api/src/platform/authorization/authorization.module';
import { AuditModule } from '../../api/src/platform/audit/audit.module';
import { DocumentModule } from '../../api/src/platform/document/document.module';
import { ExportModule } from '../../api/src/platform/export/export.module';
import { GridModule } from '../../api/src/platform/grid/grid.module';
import { NotificationModule } from '../../api/src/platform/notification/notification.module';
import { SchedulingModule } from '../../api/src/platform/scheduling/scheduling.module';
import { FormsModule } from '../../api/src/forms/forms.module';
import { TaxAssessmentModule } from '../../api/src/tax-assessment/tax-assessment.module';

/**
 * Everything the worker needs, and nothing it does not.
 *
 * Plan reference: V2 sections 6.6, 14.2.
 *
 * ## Why this imports from apps/api rather than duplicating
 *
 * The schedulers are domain code: deadline sweeping decides whether an
 * objection window has closed, and auto-closure writes a closure record. A
 * second implementation in this app would be a second set of tax rules that
 * nobody reviewed, and the two would drift on the first change.
 *
 * So the worker composes the same modules the API does. The import-boundary
 * lint rule allows this direction explicitly: `apps/worker` may reach into the
 * API's platform and domain modules, and nothing may reach back.
 *
 * ## What is deliberately absent
 *
 * `AuthModule` and every controller. The worker serves no requests, so it
 * needs no guard, no JWT verification and no routes. Importing them would give
 * a process with no listening port an authentication stack it can never use,
 * and would make its dependency graph a poor guide to what it actually does.
 *
 * `HealthModule` is likewise absent: with no HTTP server there is nothing to
 * probe. A container orchestrator watches the process, and the job registry
 * records what ran and when, which is the liveness signal that matters for
 * scheduled work.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ScheduleModule.forRoot(),
    InfrastructureModule,

    // Platform services the schedulers depend on. AuthorizationModule is here
    // because the domain services resolve permissions when acting under a
    // SYSTEM context.
    AuthorizationModule,
    AuditModule,
    DocumentModule,
    NotificationModule,
    SchedulingModule,

    // Registers and exports. The worker is where a large export is actually
    // produced: it is the process with no request waiting on it.
    GridModule,
    ExportModule,

    // Forms, because evidence retrieval reads filed returns.
    FormsModule,

    // The domain, which carries the deadline sweep and auto-closure.
    TaxAssessmentModule,
  ],
})
export class WorkerModule {}
