import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { CalculationService } from './calculation.service';
import { SimulatorService } from './simulator.service';
import { RuleSetService } from './rule-set.service';

@ApiTags('assessment')
@Controller()
export class CalculationController {
  constructor(
    private readonly calculations: CalculationService,
    private readonly ruleSets: RuleSetService,
    private readonly simulator: SimulatorService,
  ) {}

  @Post('cases/:id/calculate')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Run the authoritative calculation and store the result' })
  async calculate(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.calculations.calculateForCase(Number(id), caller!);
  }

  /**
   * What-if, without persisting.
   *
   * Separate from the persisting path so an exploratory figure can never
   * become the case's current result.
   */
  @Get('cases/:id/calculation/preview')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Calculate without storing the result' })
  async preview(@Param('id') id: string) {
    const result = await this.calculations.preview(Number(id));
    return {
      taxableBase: result.taxableBase.toString(),
      taxBeforeCredits: result.taxBeforeCredits.toString(),
      taxAfterCredits: result.taxAfterCredits.toString(),
      penaltyAmount: result.penaltyAmount.toString(),
      interestAmount: result.interestAmount.toString(),
      netPayableOrRefundable: result.netPayableOrRefundable.toString(),
      currencyCode: result.currencyCode,
      ruleSetCode: result.ruleSetCode,
      ruleSetVersion: result.ruleSetVersion,
      trace: result.trace.map((entry) => ({
        sequence: entry.sequence,
        step: entry.step,
        descriptionKey: entry.descriptionKey,
        expression: entry.expression,
        output: entry.output.toString(),
        ruleReference: entry.ruleReference ?? null,
      })),
    };
  }

  @Get('cases/:id/calculation')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The current stored result and its trace' })
  async current(@Param('id') id: string) {
    return this.calculations.currentFor(Number(id));
  }

  @Get('cases/:id/calculation/history')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Every calculation version, newest first' })
  async history(@Param('id') id: string) {
    return this.calculations.historyFor(Number(id));
  }

  @Get('rule-sets')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Tax rule sets' })
  async listRuleSets(@Query('jurisdiction') jurisdiction?: string) {
    return this.ruleSets.list(jurisdiction);
  }

  @Post('rule-sets/:id/simulate')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Replay a draft rule set over historic cases',
    description:
      'Publishing changes every case computed afterwards. This answers the question a rate ' +
      'table cannot: what would it actually have done. Nothing is persisted.',
  })
  async simulate(
    @Param('id') id: string,
    @Query('assessmentYear') assessmentYear?: string,
    @Query('limit') limit?: string,
  ) {
    return this.simulator.simulate({
      draftRuleSetId: Number(id),
      assessmentYear,
      limit: limit === undefined ? undefined : Number(limit),
    });
  }

  @Post('rule-sets/:id/publish')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Publish a rule set',
    description:
      'Requires a publisher other than the author. A wrong rate affects every case computed ' +
      'after it, so this needs a second pair of eyes.',
  })
  async publish(@Param('id') id: string) {
    return this.ruleSets.publish(Number(id));
  }
}
