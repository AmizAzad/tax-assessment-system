import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FormDefinition, FormValues } from '@tas/dynaforms-core';
import { CurrentUser, RequirePermission } from '../platform/auth/decorators';
import type { RequestContext } from '../platform/auth/request-context';
import { PermissionLevel } from '../platform/authorization/permission.model';
import { FormSubmissionService, type SaveResult } from './form-submission.service';
import { FormTemplateService, type FormTemplateRecord } from './form-template.service';

@ApiTags('forms')
@Controller('forms')
export class FormsController {
  constructor(
    private readonly templates: FormTemplateService,
    private readonly submissions: FormSubmissionService,
  ) {}

  @Get('templates')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'List form templates' })
  async list(@Query('category') category?: string): Promise<readonly FormTemplateRecord[]> {
    return this.templates.list(category);
  }

  @Get('templates/:code/published')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The published template a workflow step renders' })
  async published(
    @Param('code') code: string,
    @Query('year') year?: string,
  ): Promise<FormTemplateRecord> {
    return this.templates.findPublished(code, year);
  }

  @Post('templates')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({ summary: 'Create a draft template' })
  async create(
    @Body()
    body: {
      categoryCode: string;
      templateCode: string;
      displayKey: string;
      definition: FormDefinition;
      appliesToYear?: string;
    },
  ): Promise<FormTemplateRecord> {
    return this.templates.create(body);
  }

  /**
   * Publish a draft.
   *
   * Validation happens here rather than at save: a draft may be half-finished,
   * but a published template is about to be put in front of an officer, so a
   * circular formula reference must be caught now.
   */
  @Post('templates/:id/publish')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({ summary: 'Validate and publish a draft template' })
  async publish(@Param('id') id: string): Promise<FormTemplateRecord> {
    return this.templates.publish(Number(id));
  }

  @Post('templates/:id/clone')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({ summary: 'Clone to a new draft version' })
  async clone(
    @Param('id') id: string,
    @Body() body: { appliesToYear?: string },
  ): Promise<FormTemplateRecord> {
    return this.templates.clone(Number(id), body?.appliesToYear);
  }

  @Post('submissions/draft')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Save a draft submission without validating it' })
  async saveDraft(
    @Body()
    body: {
      formTemplateId: number;
      values: FormValues;
      contextType?: string;
      contextId?: number;
      existingUuid?: string;
    },
  ) {
    return this.submissions.saveDraft(body);
  }

  /**
   * Validate and submit.
   *
   * Returns the validation result either way. An invalid form is an expected
   * outcome the UI renders as field errors, not an exception.
   */
  @Post('submissions')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Validate and submit a form' })
  async submit(
    @Body()
    body: {
      formTemplateId: number;
      values: FormValues;
      contextType?: string;
      contextId?: number;
      existingUuid?: string;
    },
    @CurrentUser() caller: RequestContext | undefined,
  ): Promise<SaveResult> {
    return this.submissions.submit({ ...body, caller: caller! });
  }

  @Get('submissions/:uuid')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'One submission' })
  async findSubmission(@Param('uuid') uuid: string) {
    return this.submissions.findByUuid(uuid);
  }

  @Get('submissions/:uuid/revisions')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The supersession chain, newest first' })
  async revisions(@Param('uuid') uuid: string) {
    return this.submissions.revisionChain(uuid);
  }
}
