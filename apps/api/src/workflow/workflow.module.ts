import { Module } from '@nestjs/common';
import { EngineClientService } from './engine-client.service';
import { EngineEventService } from './engine-event.service';
import { EngineTokenGuard } from './engine-token.guard';
import { ReconciliationService } from './reconciliation.service';
import { TaskInboxService } from './task-inbox.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowEventsController } from './workflow-events.controller';
import { WorkflowScheduler } from './workflow.scheduler';

/**
 * The BPMN engine wrapper.
 *
 * Owns the process definition registry, the read model fed by engine webhooks,
 * the task inbox and reconciliation. The engine itself is a separate
 * deployable; this module is how the rest of the system talks to it.
 */
@Module({
  controllers: [WorkflowEventsController, WorkflowController],
  providers: [
    EngineEventService,
    EngineTokenGuard,
    EngineClientService,
    TaskInboxService,
    ReconciliationService,
    WorkflowScheduler,
  ],
  exports: [EngineEventService, EngineClientService, TaskInboxService],
})
export class WorkflowModule {}
