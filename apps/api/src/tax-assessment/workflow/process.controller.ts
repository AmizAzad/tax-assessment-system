import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RequirePermission } from '../../platform/auth/decorators';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { validateBpmn } from '../../workflow/bpmn-validator';
import type { BpmnProblem } from '../../workflow/bpmn-validator';
import { ProcessOrchestrationService } from './process-orchestration.service';

/**
 * One readable sentence from a list of problems.
 *
 * The validator reports each problem against the element that caused it, and
 * an officer fixing a diagram needs the element id as much as the reason.
 */
function describe(problems: readonly BpmnProblem[]): string {
  return problems
    .map((problem) => `${problem.elementId ?? 'definition'}: ${problem.message}`)
    .join('; ');
}

export class DeployProcessDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(50, { message: 'That is not a BPMN definition.' })
  bpmnXml!: string;
}

/**
 * Deploying and inspecting process definitions.
 *
 * Plan reference: V2 sections 5.2, 5.4.
 *
 * ## Why deployment is an endpoint and not a startup step
 *
 * A definition reaching the engine is a change to how work is coordinated for
 * every case opened afterwards. Deploying from the classpath on boot would
 * mean an edited file taking effect because somebody restarted a pod.
 *
 * It is also why the validator runs here first. The engine will happily accept
 * a user task with no candidate group; the case would then wait forever on a
 * task that appears in nobody's inbox, and nothing would look broken.
 */
@ApiTags('workflow')
@Controller('processes')
export class ProcessController {
  constructor(private readonly processes: ProcessOrchestrationService) {}

  @Post('deploy')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Validate and deploy a process definition',
    description:
      'Rejected before it reaches the engine if a user task names no candidate group, or a ' +
      'service task names anything but the apiInvoker delegate.',
  })
  async deploy(@Body() body: DeployProcessDto) {
    const result = validateBpmn(body.bpmnXml);
    if (!result.valid) {
      throw new BadRequestException({
        message: `The definition was refused: ${describe(result.problems)}`,
        problems: result.problems,
      });
    }
    return this.processes.deploy(body.name, body.bpmnXml);
  }

  /**
   * Deploy the definition shipped with this release.
   *
   * A convenience for setting an environment up, and the path a deployment
   * pipeline calls. It reads the file from disk and then goes through exactly
   * the same validation as an uploaded one: a definition being ours is not a
   * reason to trust it less carefully.
   */
  @Post('deploy/standard')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({ summary: 'Deploy the assessment definition shipped with this release' })
  async deployStandard() {
    const path = join(process.cwd(), '..', '..', 'db', 'bpmn', 'TAX_ASSESSMENT_MAIN.bpmn20.xml');
    let bpmnXml: string;
    try {
      bpmnXml = await readFile(path, 'utf8');
    } catch {
      throw new BadRequestException(
        `The standard definition was not found at ${path}. It ships in db/bpmn.`,
      );
    }

    const result = validateBpmn(bpmnXml);
    if (!result.valid) {
      throw new BadRequestException({
        message:
          'The definition shipped with this release does not pass validation, which is a defect ' +
          `in the release: ${describe(result.problems)}`,
        problems: result.problems,
      });
    }

    return this.processes.deploy('TAX_ASSESSMENT_MAIN', bpmnXml);
  }

  @Post('validate')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Check a definition without deploying it',
    description: 'For an author iterating on a diagram before asking for it to be deployed.',
  })
  async validate(@Body() body: DeployProcessDto) {
    return validateBpmn(body.bpmnXml);
  }

  @Get('cases/:id')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The process instance coordinating a case' })
  async forCase(@Param('id') id: string) {
    return this.processes.instanceFor(Number(id));
  }

  @Get('cases/:id/journey')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Where a case has reached in its process',
    description:
      'The diagram the case is running under, plus the activities that have finished and the ' +
      'ones running now. A case with no process comes back marked as such rather than as an ' +
      'error: a case opened while the engine was unreachable is worked by hand.',
  })
  async journey(@Param('id') id: string) {
    const caseId = Number(id);
    if (!Number.isInteger(caseId) || caseId <= 0) {
      throw new BadRequestException('A case id is a positive whole number');
    }
    return this.processes.journey(caseId);
  }

  @Get('definitions/:key')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'A registered process definition, as XML',
    description:
      'Read from our own registry rather than the engine, so a diagram still opens while the ' +
      'engine is restarting. The registry row is the one that was validated and approved.',
  })
  async definition(@Param('key') key: string) {
    return this.processes.definitionXml(key);
  }
}
