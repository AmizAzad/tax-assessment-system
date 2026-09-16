import { Body, Controller, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { DeadlineService } from '../deadline/deadline.service';
import { SlaService } from '../deadline/sla.service';
import { NoticeService } from './notice.service';
import { ServiceDeliveryService } from './service-delivery.service';

export class GenerateNoticeDto {
  @IsString()
  @MaxLength(40)
  noticeType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  languageCode?: string;
}

export class ServeNoticeDto {
  @IsIn(['EMAIL', 'SMS', 'PORTAL', 'REGISTERED_POST', 'HAND_DELIVERY', 'PUBLICATION'])
  channel!: 'EMAIL' | 'SMS' | 'PORTAL' | 'REGISTERED_POST' | 'HAND_DELIVERY' | 'PUBLICATION';

  @IsString()
  @MaxLength(320)
  addressee!: string;

  @IsOptional()
  @IsObject()
  addressSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  proofReference?: string;
}

export class ServiceOutcomeDto {
  @IsIn(['DELIVERED', 'READ', 'FAILED', 'RETURNED'])
  status!: 'DELIVERED' | 'READ' | 'FAILED' | 'RETURNED';

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  proofReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  failureReason?: string;
}

@ApiTags('notices')
@Controller()
export class NoticeController {
  constructor(
    private readonly notices: NoticeService,
    private readonly delivery: ServiceDeliveryService,
    private readonly deadlines: DeadlineService,
    private readonly sla: SlaService,
  ) {}

  @Post('cases/:id/notices')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Generate a notice for a case',
    description:
      'Only from a finalised assessment: a notice gives legal effect to a determination. ' +
      'Re-generating produces a new version rather than overwriting, because the taxpayer may ' +
      'be holding the previous one.',
  })
  async generate(
    @Param('id') id: string,
    @Body() body: GenerateNoticeDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.notices.generate(Number(id), body, caller!);
  }

  @Get('cases/:id/notices')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Notices issued on a case' })
  async listForCase(@Param('id') id: string) {
    return this.notices.listForCase(Number(id));
  }

  @Get('notices/:uuid')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'A notice, with its rendered content and service position' })
  async read(@Param('uuid') uuid: string) {
    const notice = await this.notices.findByUuid(uuid);
    return { ...notice, serviceAttempts: await this.delivery.attemptsFor(uuid) };
  }

  @Get('notices/:uuid/verify')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Confirm a notice still says what it said when it was served',
    description:
      'Recomputes the content hash. Over the content, not the PDF bytes: a PDF embeds a ' +
      'creation timestamp, so a byte hash would report every re-render as tampering.',
  })
  async verify(@Param('uuid') uuid: string) {
    return this.notices.verify(uuid);
  }

  @Get('notices/:uuid/document')
  @RequirePermission(PermissionLevel.VIEW)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download the rendered notice' })
  async document(
    @Param('uuid') uuid: string,
    @Res() response: { setHeader: (k: string, v: string) => void; send: (b: Buffer) => void },
  ): Promise<void> {
    const { filename, body } = await this.notices.documentFor(uuid);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.send(body);
  }

  @Post('notices/:uuid/serve')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Serve a notice through a channel',
    description:
      'Records the attempt and computes the deemed service date from the jurisdiction rule. ' +
      'The objection window runs from deemed service, not from despatch.',
  })
  async serve(
    @Param('uuid') uuid: string,
    @Body() body: ServeNoticeDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.delivery.serve(uuid, body, caller!);
  }

  @Post('notices/:uuid/service/:serviceId/outcome')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Record what happened to a service attempt',
    description:
      'Actual delivery can pull the deemed date earlier where the jurisdiction allows it. It ' +
      'never pushes it later. If every attempt fails the notice reverts to unserved.',
  })
  async outcome(
    @Param('uuid') uuid: string,
    @Param('serviceId') serviceId: string,
    @Body() body: ServiceOutcomeDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.delivery.recordOutcome(uuid, Number(serviceId), body, caller!);
  }

  @Get('cases/:id/deadlines/recorded')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Deadlines actually running on a case, with their state' })
  async recordedDeadlines(@Param('id') id: string) {
    return this.deadlines.recordedFor(Number(id));
  }

  @Get('cases/:id/sla')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Internal service clocks on a case',
    description:
      'Administrative targets, not statutory dates. A missed service standard is never a time ' +
      'bar, which is why these live apart from the deadlines.',
  })
  async slaClocks(@Param('id') id: string) {
    return this.sla.forCase(Number(id));
  }

  @Get('notice-templates')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Notice wording templates' })
  async templates(@Query('jurisdiction') jurisdiction?: string) {
    return this.notices.templates(jurisdiction);
  }

  @Post('notice-templates/:id/publish')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Publish notice wording',
    description:
      'Checks every token the template uses against what the system can supply, so a template ' +
      'referencing a value nothing produces is rejected here rather than at the moment an ' +
      'officer tries to issue a notice.',
  })
  async publish(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.notices.publishTemplate(Number(id), caller!);
  }
}
