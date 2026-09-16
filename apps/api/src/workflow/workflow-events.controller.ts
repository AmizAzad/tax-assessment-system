import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../platform/auth/decorators';
import { EngineEventService, type EngineEvent, type IngestOutcome } from './engine-event.service';
import { EngineTokenGuard } from './engine-token.guard';

/**
 * Receives lifecycle events from the BPMN engine.
 *
 * Plan reference: V2 sections 5.1, 5.4.
 *
 * @Public bypasses the *user* guard, because the caller is the engine and
 * there is no person to authorise. EngineTokenGuard is what actually protects
 * the route: it requires the shared service token, compared in constant time,
 * and rejects everything outside development when no token is configured.
 */
@ApiTags('workflow')
@Controller('workflow')
@UseGuards(EngineTokenGuard)
export class WorkflowEventsController {
  constructor(private readonly engineEvents: EngineEventService) {}

  @Post('events')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Ingest a BPMN engine lifecycle event' })
  async receive(@Body() event: EngineEvent): Promise<IngestOutcome> {
    return this.engineEvents.ingest(event);
  }
}
