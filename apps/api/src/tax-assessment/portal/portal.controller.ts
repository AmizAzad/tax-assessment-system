import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { DocumentService } from '../../platform/document/document.service';
import { FileObjectionDto } from '../dispute/dispute.controller';
import { PortalService } from './portal.service';

/**
 * The taxpayer's own view of their affairs.
 *
 * Plan reference: V2 sections 15.1 to 15.4.
 *
 * ## Why these routes are separate from the officer ones
 *
 * They could have been the same endpoints with a wider scope predicate. They
 * are not, for two reasons.
 *
 * The first is blast radius. An officer endpoint that also serves taxpayers is
 * one mistake away from serving a taxpayer somebody else's case, and that
 * mistake would be a change to a scope clause nobody reviewed as a
 * disclosure decision. A separate controller whose every method resolves the
 * caller's own taxpayer makes the rule visible in one file.
 *
 * The second is shape. A taxpayer is entitled to the notice served on them and
 * the figures it states, not to the officer's working papers. Sharing the
 * endpoints would mean deciding what to strip on the way out, which is the
 * wrong way round: the portal should assemble what may be disclosed rather
 * than redact what may not.
 *
 * ## Rate limiting
 *
 * These are the endpoints reachable by anyone who can register, so they carry
 * their own limits. Filing is limited harder than reading: an objection is a
 * legal act and nobody legitimately files ten in a minute, whereas a taxpayer
 * refreshing their own case list is ordinary behaviour.
 */
@ApiTags('portal')
@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly documents: DocumentService,
  ) {}

  @Get('me')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Who this portal session acts for',
    description:
      'Resolved from the recorded authority on every request, not from a token claim: an ' +
      'authority that ended this morning must not open a file this afternoon.',
  })
  async me(@CurrentUser() caller: RequestContext | undefined) {
    return this.portal.identity(caller!);
  }

  @Get('cases')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'My assessments',
    description:
      'Only those that have been served. An assessment still in preparation is working ' +
      'material, and showing it would invite a dispute about a figure nobody has decided.',
  })
  async cases(@CurrentUser() caller: RequestContext | undefined) {
    return this.portal.cases(caller!);
  }

  @Get('cases/:id')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'One of my assessments, with the figures the notice states' })
  async caseDetail(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.portal.caseDetail(caller!, Number(id));
  }

  @Get('cases/:id/notices')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Notices served on me' })
  async notices(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.portal.notices(caller!, Number(id));
  }

  @Get('notices/:uuid/document')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Download a notice served on me' })
  async document(
    @Param('uuid') uuid: string,
    @CurrentUser() caller: RequestContext | undefined,
    @Res() response: { setHeader: (k: string, v: string) => void; send: (b: Buffer) => void },
  ): Promise<void> {
    // Ownership is established before the document service is asked for
    // anything, so a guessed notice uuid never reaches the store.
    const documentUuid = await this.portal.noticeDocument(caller!, uuid);
    const downloaded = await this.documents.download(documentUuid);

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloaded.record.filename}"`,
    );
    response.send(downloaded.body);
  }

  @Get('cases/:id/objections')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Objections I have filed on this assessment' })
  async objections(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.portal.objectionsFor(caller!, Number(id));
  }

  @Post('cases/:id/objections')
  @RequirePermission(PermissionLevel.EDIT)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'File an objection against my assessment',
    description:
      'Held to exactly the rules an officer-recorded objection is held to, in both directions: ' +
      'the grounds requirement applies, and a late objection is accepted and put to an officer ' +
      'rather than refused at the door. Limited to five an hour, because filing is a legal act.',
  })
  async fileObjection(
    @Param('id') id: string,
    @Body() body: FileObjectionDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.portal.fileObjection(caller!, Number(id), body);
  }

  @Get('objections/:uuid/deposit')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'What deposit my objection requires, and how it was worked out',
    description: 'A jurisdiction with no configured rule requires nothing.',
  })
  async deposit(@Param('uuid') uuid: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.portal.depositFor(caller!, uuid);
  }

  @Get('account')
  @RequirePermission(PermissionLevel.VIEW)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'My payments, credits and losses' })
  async account(@CurrentUser() caller: RequestContext | undefined) {
    return this.portal.account(caller!);
  }
}
