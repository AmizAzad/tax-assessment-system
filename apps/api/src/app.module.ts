import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { FormsModule } from './forms/forms.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { ApiTraceInterceptor } from './platform/audit/api-trace.interceptor';
import { AuditModule } from './platform/audit/audit.module';
import { AuthModule } from './platform/auth/auth.module';
import { AuthorizationModule } from './platform/authorization/authorization.module';
import { DocumentModule } from './platform/document/document.module';
import { ExportModule } from './platform/export/export.module';
import { GridModule } from './platform/grid/grid.module';
import { HealthModule } from './platform/health/health.module';
import { I18nModule } from './platform/i18n/i18n.module';
import { MastersModule } from './platform/masters/masters.module';
import { NotificationModule } from './platform/notification/notification.module';
import { SchedulingModule } from './platform/scheduling/scheduling.module';
import { TaxAssessmentModule } from './tax-assessment/tax-assessment.module';
import { WorkflowModule } from './workflow/workflow.module';

/**
 * Application root.
 *
 * The four groupings mirror plan section 14.2: platform, forms, workflow,
 * tax-assessment. The import direction between them is enforced by the
 * boundaries lint rule, not by convention.
 *
 * AuthModule registers a global guard, so every route added below is protected
 * by default and must opt out explicitly with @Public().
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ScheduleModule.forRoot(),

    /**
     * Rate limiting.
     *
     * A generous default for officer traffic, with the portal routes
     * tightening it per endpoint. The default is deliberately not restrictive:
     * a caseworker paging a register legitimately makes many requests, and a
     * limit that fired on ordinary work would be turned off.
     *
     * The portal is where the limits earn their place, because those routes
     * are reachable by anyone who can register an account.
     */
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    InfrastructureModule,

    // --- platform ---
    AuthorizationModule, // before AuthModule: the guard depends on the catalogue
    AuthModule,
    AuditModule,
    I18nModule,
    DocumentModule,
    NotificationModule,
    SchedulingModule,
    GridModule,
    ExportModule,
    HealthModule,
    MastersModule,

    // --- forms ---
    FormsModule,

    // --- workflow ---
    WorkflowModule,

    // --- tax-assessment ---
    TaxAssessmentModule,
  ],
  providers: [
    {
      /**
       * Enforces the rate limits.
       *
       * Registering `ThrottlerModule` alone declares limits that nothing
       * applies. That is worse than having none: the decorators read as
       * protection, and a portal endpoint that looks limited and is not would
       * only be discovered by whoever abused it.
       */
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      // Records who called what. Registered globally so a new route is traced
      // by default rather than when someone remembers to add it.
      provide: APP_INTERCEPTOR,
      useClass: ApiTraceInterceptor,
    },
  ],
})
export class AppModule {}
