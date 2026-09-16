import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../platform/auth/decorators';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { ReportingService, type ReportFilters } from './reporting.service';

@ApiTags('reports')
@Controller('reports')
export class ReportingController {
  constructor(private readonly reports: ReportingService) {}

  /**
   * Filters are shared by every report.
   *
   * Read off the query string rather than a DTO because they are all optional
   * scalars; the service binds them as parameters, never as SQL text.
   */
  private filtersFrom(
    jurisdiction?: string,
    taxType?: string,
    assessmentYear?: string,
    from?: string,
    to?: string,
  ): ReportFilters {
    return { jurisdiction, taxType, assessmentYear, from, to };
  }

  @Get('assessment-summary')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Cases and net assessed by status' })
  async assessmentSummary(
    @Query('jurisdiction') jurisdiction?: string,
    @Query('taxType') taxType?: string,
    @Query('assessmentYear') assessmentYear?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.assessmentSummary(
      this.filtersFrom(jurisdiction, taxType, assessmentYear, from, to),
    );
  }

  @Get('collection')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Assessed against collected',
    description:
      'Payments are read from the taxpayer account rather than inferred from case status: a ' +
      'closed case is not necessarily a paid one.',
  })
  async collection(
    @Query('jurisdiction') jurisdiction?: string,
    @Query('taxType') taxType?: string,
    @Query('assessmentYear') assessmentYear?: string,
  ) {
    return this.reports.collection(this.filtersFrom(jurisdiction, taxType, assessmentYear));
  }

  @Get('adjustment-analysis')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Adjustment reasons ranked by value',
    description: 'Which risk rules earn their keep, and which are noise.',
  })
  async adjustments(
    @Query('jurisdiction') jurisdiction?: string,
    @Query('taxType') taxType?: string,
  ) {
    return this.reports.adjustmentAnalysis(this.filtersFrom(jurisdiction, taxType));
  }

  @Get('dispute-outcomes')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'How often the authority is overturned',
    description:
      'A jurisdiction losing most of its objections has an assessment quality problem, not a ' +
      'dispute problem.',
  })
  async disputes(@Query('jurisdiction') jurisdiction?: string) {
    return this.reports.disputeOutcomes(this.filtersFrom(jurisdiction));
  }

  @Get('ageing')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Where cases are stuck, and for how long' })
  async ageing(@Query('jurisdiction') jurisdiction?: string) {
    return this.reports.ageing(this.filtersFrom(jurisdiction));
  }

  @Get('deadline-exposure')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Statutory clocks overdue or about to run out' })
  async deadlines() {
    return this.reports.deadlineExposure();
  }

  @Get('unserved-notices')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Notices issued but never successfully served',
    description:
      'An unserved notice starts no clock, so these cases are silently frozen. Nothing else ' +
      'in the system surfaces them.',
  })
  async unserved() {
    return this.reports.unservedNotices();
  }

  @Get('reconciliation')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Places where the register contradicts itself',
    description:
      'Every row returned is a defect, not a metric. An empty result is the expected answer.',
  })
  async reconciliation() {
    return this.reports.reconciliation();
  }
}
