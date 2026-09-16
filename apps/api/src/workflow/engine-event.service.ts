import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../infrastructure/tokens';

/**
 * An engine lifecycle event, as delivered by the BPMN service.
 *
 * Deliberately permissive: this crosses a process boundary from a component
 * with its own release cycle, so an unrecognised field must not break
 * ingestion.
 */
export interface EngineEvent {
  readonly eventType: string;
  readonly occurredAt?: string;
  readonly processInstanceId?: string;
  readonly processDefinitionId?: string;
  readonly processDefinitionKey?: string;
  readonly businessKey?: string;
  readonly taskId?: string;
  readonly taskName?: string;
  readonly taskDefinitionKey?: string;
  readonly assignee?: string;
  readonly dueDate?: string;
  /** Role codes the task is offered to. The inbox filters on these. */
  readonly candidateGroups?: readonly string[];
  readonly activityId?: string;
  readonly activityName?: string;
  readonly activityType?: string;
}

export interface IngestOutcome {
  readonly accepted: boolean;
  readonly applied: boolean;
  readonly reason?: string;
}

/**
 * Projects engine events into the workflow read model.
 *
 * Plan reference: V2 sections 5.4, 5.5; ADR-002.
 *
 * ## Journal first, project second
 *
 * Every event is written to `engine_event` before anything is derived from
 * it. Delivery is best-effort and the engine gives up after a few attempts,
 * so the journal is what lets the reconciliation job tell "we never received
 * this" from "we received it and failed to apply it". Those need different
 * remedies, and without the journal they look identical.
 *
 * ## Unknown events are accepted, not rejected
 *
 * An event type this build does not project is journalled and acknowledged.
 * Returning an error would make the engine retry forever for something we
 * have deliberately chosen not to act on.
 */
@Injectable()
export class EngineEventService {
  private readonly logger = new Logger(EngineEventService.name);

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async ingest(event: EngineEvent): Promise<IngestOutcome> {
    if (!event.eventType) {
      return { accepted: false, applied: false, reason: 'eventType is required' };
    }

    const journalId = await this.journal(event);

    try {
      const applied = await this.project(event);
      await this.sequelize.query(
        `UPDATE workflow.engine_event SET applied_at = CURRENT_TIMESTAMP WHERE id = :id`,
        { type: QueryTypes.UPDATE, replacements: { id: journalId } },
      );
      return { accepted: true, applied };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      // Recorded rather than thrown: the engine has already moved on, and a
      // 500 here just burns its retry budget. Reconciliation repairs the
      // projection; the journal row is the evidence.
      await this.sequelize.query(
        `UPDATE workflow.engine_event SET apply_error = :error WHERE id = :id`,
        { type: QueryTypes.UPDATE, replacements: { id: journalId, error: message } },
      );
      this.logger.error(
        `Failed to project ${event.eventType} for instance ${event.processInstanceId}: ${message}`,
      );
      return { accepted: true, applied: false, reason: message };
    }
  }

  private async journal(event: EngineEvent): Promise<number> {
    const rows = await this.sequelize.query<{ id: string }>(
      `INSERT INTO workflow.engine_event
              (event_type, process_instance_id, task_id, payload_json)
       VALUES (:eventType, :processInstanceId, :taskId, CAST(:payload AS jsonb))
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          eventType: event.eventType,
          processInstanceId: event.processInstanceId ?? null,
          taskId: event.taskId ?? null,
          payload: JSON.stringify(event),
        },
      },
    );
    return Number(rows[0]!.id);
  }

  /** @returns whether this event type is projected by this build */
  private async project(event: EngineEvent): Promise<boolean> {
    switch (event.eventType) {
      case 'PROCESS_STARTED':
        await this.upsertSnapshot(event, 'RUNNING');
        return true;

      case 'PROCESS_COMPLETED':
        await this.endSnapshot(event, 'COMPLETED');
        return true;

      case 'PROCESS_CANCELLED':
        await this.endSnapshot(event, 'CANCELLED');
        return true;

      case 'TASK_CREATED':
        await this.openTask(event);
        return true;

      case 'TASK_COMPLETED':
        await this.closeTask(event);
        return true;

      case 'ACTIVITY_STARTED':
      case 'ACTIVITY_COMPLETED':
        await this.recordActivity(event);
        return true;

      default:
        this.logger.debug(`No projection for event type ${event.eventType}; journalled only`);
        return false;
    }
  }

  private async upsertSnapshot(event: EngineEvent, status: string): Promise<void> {
    if (event.processInstanceId === undefined) return;
    await this.sequelize.query(
      `INSERT INTO workflow.process_snapshot
              (process_instance_id, engine_definition_id, workflow_code, business_key,
               status, started_at, last_event_at)
       VALUES (:processInstanceId, :definitionId, :workflowCode, :businessKey,
               :status, :occurredAt, CURRENT_TIMESTAMP)
       ON CONFLICT (process_instance_id) DO UPDATE
          SET status        = EXCLUDED.status,
              business_key  = COALESCE(EXCLUDED.business_key, workflow.process_snapshot.business_key),
              last_event_at = CURRENT_TIMESTAMP,
              updated_at    = CURRENT_TIMESTAMP`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          processInstanceId: event.processInstanceId,
          definitionId: event.processDefinitionId ?? null,
          workflowCode: event.processDefinitionKey ?? null,
          businessKey: event.businessKey ?? null,
          status,
          occurredAt: event.occurredAt ?? new Date().toISOString(),
        },
      },
    );
  }

  private async endSnapshot(event: EngineEvent, status: string): Promise<void> {
    if (event.processInstanceId === undefined) return;
    // Upsert rather than update: a completed instance may be the first event
    // we see if an earlier one was lost.
    await this.upsertSnapshot(event, status);
    await this.sequelize.query(
      `UPDATE workflow.process_snapshot
          SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
              status = :status,
              updated_at = CURRENT_TIMESTAMP
        WHERE process_instance_id = :processInstanceId`,
      {
        type: QueryTypes.UPDATE,
        replacements: { processInstanceId: event.processInstanceId, status },
      },
    );
  }

  private async openTask(event: EngineEvent): Promise<void> {
    if (event.taskId === undefined || event.processInstanceId === undefined) return;

    await this.sequelize.query(
      `INSERT INTO workflow.active_task
              (task_id, process_instance_id, business_key, task_definition_key,
               step_code, name, assignee, due_at, task_created_at)
       VALUES (:taskId, :processInstanceId, :businessKey, :taskDefinitionKey,
               :stepCode, :name, :assignee, :dueAt, :createdAt)
       ON CONFLICT (task_id) DO UPDATE
          SET assignee   = EXCLUDED.assignee,
              due_at     = EXCLUDED.due_at,
              updated_at = CURRENT_TIMESTAMP`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          taskId: event.taskId,
          processInstanceId: event.processInstanceId,
          businessKey: event.businessKey ?? null,
          taskDefinitionKey: event.taskDefinitionKey ?? null,
          // The step code convention is that it matches the task definition
          // key; the authoritative value comes from the published definition.
          stepCode: event.taskDefinitionKey ?? null,
          name: event.taskName ?? null,
          assignee: event.assignee ?? null,
          dueAt: event.dueDate ?? null,
          createdAt: event.occurredAt ?? new Date().toISOString(),
        },
      },
    );

    // The roles the task is offered to. Without these the task exists in the
    // read model and appears in nobody's inbox, which looks exactly like no
    // work existing. Replaced rather than merged, because the engine's
    // identity links are the authority on who may claim it.
    await this.sequelize.query(`DELETE FROM workflow.active_task_role WHERE task_id = :taskId`, {
      type: QueryTypes.DELETE,
      replacements: { taskId: event.taskId },
    });

    const candidateGroups = event.candidateGroups ?? [];
    for (const roleCode of candidateGroups) {
      await this.sequelize.query(
        `INSERT INTO workflow.active_task_role (task_id, role_code, created_at)
         VALUES (:taskId, :roleCode, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`,
        { type: QueryTypes.INSERT, replacements: { taskId: event.taskId, roleCode } },
      );
    }

    if (candidateGroups.length === 0) {
      // The publish-time validator refuses a definition with a role-less user
      // task, so reaching here means either a definition deployed around the
      // API or an engine that could not read its own identity links. Both are
      // worth saying out loud: the task is invisible either way.
      this.logger.warn(
        `Task ${event.taskId} (${event.taskName ?? 'unnamed'}) was created with no candidate ` +
          'groups and will appear in no inbox.',
      );
    }

    // A task with a due date gets an SLA row, so "which cases are breaching"
    // is a query rather than a scan of engine timers.
    if (event.dueDate !== undefined && event.dueDate !== null) {
      await this.sequelize.query(
        `INSERT INTO workflow.sla_tracker
                (task_id, process_instance_id, business_key, step_code, due_at)
         VALUES (:taskId, :processInstanceId, :businessKey, :stepCode, :dueAt)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            taskId: event.taskId,
            processInstanceId: event.processInstanceId,
            businessKey: event.businessKey ?? null,
            stepCode: event.taskDefinitionKey ?? null,
            dueAt: event.dueDate,
          },
        },
      );
    }
  }

  private async closeTask(event: EngineEvent): Promise<void> {
    if (event.taskId === undefined) return;

    await this.sequelize.query(
      `UPDATE workflow.active_task
          SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
        WHERE task_id = :taskId`,
      { type: QueryTypes.UPDATE, replacements: { taskId: event.taskId } },
    );

    await this.sequelize.query(
      `UPDATE workflow.sla_tracker
          SET resolved_at = CURRENT_TIMESTAMP,
              status = CASE WHEN breached_at IS NULL THEN 'MET' ELSE 'BREACHED' END,
              updated_at = CURRENT_TIMESTAMP
        WHERE task_id = :taskId AND resolved_at IS NULL`,
      { type: QueryTypes.UPDATE, replacements: { taskId: event.taskId } },
    );
  }

  private async recordActivity(event: EngineEvent): Promise<void> {
    if (event.processInstanceId === undefined) return;
    await this.sequelize.query(
      `INSERT INTO workflow.activity_progress
              (process_instance_id, activity_id, activity_name, activity_type,
               event_type, occurred_at)
       VALUES (:processInstanceId, :activityId, :activityName, :activityType,
               :eventType, :occurredAt)`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          processInstanceId: event.processInstanceId,
          activityId: event.activityId ?? null,
          activityName: event.activityName ?? null,
          activityType: event.activityType ?? null,
          eventType: event.eventType,
          occurredAt: event.occurredAt ?? new Date().toISOString(),
        },
      },
    );

    if (event.eventType === 'ACTIVITY_STARTED' && event.activityId !== undefined) {
      await this.sequelize.query(
        `UPDATE workflow.process_snapshot
            SET current_step_code = :activityId,
                last_event_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE process_instance_id = :processInstanceId`,
        {
          type: QueryTypes.UPDATE,
          replacements: {
            processInstanceId: event.processInstanceId,
            activityId: event.activityId,
          },
        },
      );
    }
  }
}
