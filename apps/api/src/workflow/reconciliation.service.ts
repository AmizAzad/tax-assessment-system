import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../infrastructure/tokens';
import { EngineClientService } from './engine-client.service';

export interface ReconciliationReport {
  readonly checkedInstances: number;
  readonly staleTasksClosed: number;
  readonly missingTasksAdded: number;
  readonly unappliedEvents: number;
  readonly divergences: readonly string[];
  readonly engineReachable: boolean;
}

/**
 * Repairs divergence between the engine and the read model.
 *
 * Plan reference: V2 sections 5.5, 17.3, 27.4; ADR-002.
 *
 * ADR-002 accepted eventual consistency as the cost of an engine that owns
 * state we do not, and promised this job as the mitigation. Webhook delivery
 * is best-effort: the engine retries three times and then gives up, on purpose,
 * because a webhook that can roll back a process transition would make the
 * API's availability a precondition for the engine making progress.
 *
 * So the read model can drift. Two ways, with different consequences:
 *
 *   - **A task closed in the engine but still open here.** An officer sees
 *     work in their inbox that no longer exists. Annoying, self-correcting
 *     once noticed.
 *   - **A task open in the engine but missing here.** Nobody sees it. A review
 *     sits untouched until a statutory deadline passes. This is the one that
 *     matters, and it is why this job exists.
 *
 * The engine is authoritative. Where they disagree, the read model is wrong.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly engine: EngineClientService,
  ) {}

  /**
   * Compare running instances against the engine and repair what differs.
   *
   * @param limit instances per pass. Bounded so a backlog is worked through
   *        over several runs rather than one long-running pass holding
   *        connections open.
   */
  async reconcile(limit = 100): Promise<ReconciliationReport> {
    const divergences: string[] = [];

    if (!(await this.engine.isReachable())) {
      // Nothing can be concluded while the engine is down. Reporting
      // divergence here would be false: we simply do not know.
      this.logger.warn('Skipping reconciliation: the workflow engine is unreachable');
      return {
        checkedInstances: 0,
        staleTasksClosed: 0,
        missingTasksAdded: 0,
        unappliedEvents: await this.countUnappliedEvents(),
        divergences: [],
        engineReachable: false,
      };
    }

    const instances = await this.sequelize.query<{ process_instance_id: string }>(
      `SELECT process_instance_id
         FROM workflow.process_snapshot
        WHERE status = 'RUNNING' AND is_active
        ORDER BY last_event_at NULLS FIRST
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { limit } },
    );

    let staleTasksClosed = 0;
    let missingTasksAdded = 0;

    for (const { process_instance_id: processInstanceId } of instances) {
      let engineTasks;
      try {
        engineTasks = await this.engine.listTasks(processInstanceId);
      } catch (error) {
        divergences.push(
          `Could not read tasks for ${processInstanceId}: ` +
            `${error instanceof Error ? error.message : 'unknown error'}`,
        );
        continue;
      }

      const engineTaskIds = new Set(engineTasks.map((task) => task.taskId));

      const openHere = await this.sequelize.query<{ task_id: string }>(
        `SELECT task_id FROM workflow.active_task
          WHERE process_instance_id = :processInstanceId AND completed_at IS NULL`,
        { type: QueryTypes.SELECT, replacements: { processInstanceId } },
      );

      // Open here, gone from the engine: a TASK_COMPLETED we never received.
      for (const { task_id: taskId } of openHere) {
        if (!engineTaskIds.has(taskId)) {
          await this.sequelize.query(
            `UPDATE workflow.active_task
                SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE task_id = :taskId`,
            { type: QueryTypes.UPDATE, replacements: { taskId } },
          );
          staleTasksClosed += 1;
          divergences.push(`Closed stale task ${taskId} (completed in the engine)`);
        }
      }

      // Open in the engine, missing here: a TASK_CREATED we never received.
      // The serious case — nobody can see this work.
      const openHereIds = new Set(openHere.map((row) => row.task_id));
      for (const task of engineTasks) {
        if (!openHereIds.has(task.taskId)) {
          await this.sequelize.query(
            `INSERT INTO workflow.active_task
                    (task_id, process_instance_id, task_definition_key, step_code,
                     name, assignee, due_at, task_created_at)
             VALUES (:taskId, :processInstanceId, :taskDefinitionKey, :stepCode,
                     :name, :assignee, :dueAt, CURRENT_TIMESTAMP)
             ON CONFLICT (task_id) DO UPDATE
                    SET completed_at = NULL, updated_at = CURRENT_TIMESTAMP`,
            {
              type: QueryTypes.INSERT,
              replacements: {
                taskId: task.taskId,
                processInstanceId: task.processInstanceId,
                taskDefinitionKey: task.taskDefinitionKey ?? null,
                stepCode: task.taskDefinitionKey ?? null,
                name: task.name ?? null,
                assignee: task.assignee ?? null,
                dueAt: task.dueDate ?? null,
              },
            },
          );
          missingTasksAdded += 1;
          divergences.push(
            `Recovered task ${task.taskId} (${task.taskDefinitionKey ?? 'unknown step'}) ` +
              `that was open in the engine but invisible here`,
          );
        }
      }
    }

    const unappliedEvents = await this.countUnappliedEvents();

    if (divergences.length > 0) {
      // Worth alerting on: a healthy system reconciles to nothing.
      this.logger.warn(
        `Reconciliation repaired ${divergences.length} divergence(s) across ` +
          `${instances.length} instance(s)`,
      );
      for (const divergence of divergences) {
        this.logger.warn(`  ${divergence}`);
      }
    }

    if (unappliedEvents > 0) {
      // Received but not projected: a bug in the projection, not a lost
      // webhook. Different remedy, which is why the journal distinguishes them.
      this.logger.error(
        `${unappliedEvents} engine event(s) were received but never applied. ` +
          `Check workflow.engine_event.apply_error.`,
      );
    }

    return {
      checkedInstances: instances.length,
      staleTasksClosed,
      missingTasksAdded,
      unappliedEvents,
      divergences,
      engineReachable: true,
    };
  }

  private async countUnappliedEvents(): Promise<number> {
    const rows = await this.sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workflow.engine_event
        WHERE applied_at IS NULL
          AND received_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'`,
      { type: QueryTypes.SELECT },
    );
    return Number(rows[0]?.n ?? 0);
  }
}
