import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../infrastructure/tokens';
import type { RequestContext } from '../platform/auth/request-context';
import { EngineClientService } from './engine-client.service';

export interface InboxTask {
  readonly taskId: string;
  readonly processInstanceId: string;
  readonly businessKey?: string;
  readonly stepCode?: string;
  readonly name?: string;
  readonly assignee?: string;
  readonly dueAt?: Date;
  readonly createdAt?: Date;
  readonly roleCodes: readonly string[];
  /** Present when the task is past its due date. */
  readonly overdue: boolean;
}

/**
 * The officer's task inbox.
 *
 * Plan reference: V2 sections 5.4, 9.1, 18.1.
 *
 * ## Served from the read model, not the engine
 *
 * Every render of an inbox would otherwise be a call to a second service. The
 * read model is fed by engine webhooks and can lag by seconds; an inbox that
 * is a few seconds stale is fine, an inbox that fails when the engine is
 * restarting is not.
 *
 * ## Role filtering is a scope predicate, not a filter parameter
 *
 * A caller never says which roles to filter by — that is taken from the
 * authenticated context. Otherwise the inbox becomes an enumeration oracle:
 * pass someone else's role and read their queue.
 */
@Injectable()
export class TaskInboxService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly engine: EngineClientService,
  ) {}

  /**
   * Open tasks this caller may act on.
   *
   * A task with no role rows is excluded rather than shown to everyone.
   * Publish-time validation should make that impossible, but if a definition
   * slipped through, the failure mode must be "nobody sees it" rather than
   * "everybody does" (plan 5.5).
   */
  async forCaller(caller: RequestContext, limit = 100): Promise<readonly InboxTask[]> {
    if (caller.roleCodes.length === 0) {
      return [];
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT t.task_id, t.process_instance_id, t.business_key, t.step_code,
              t.name, t.assignee, t.due_at, t.task_created_at,
              COALESCE(
                (SELECT json_agg(r.role_code)
                   FROM workflow.active_task_role r
                  WHERE r.task_id = t.task_id),
                '[]'::json
              ) AS role_codes
         FROM workflow.active_task t
        WHERE t.completed_at IS NULL
          AND t.is_active
          AND EXISTS (
                SELECT 1 FROM workflow.active_task_role r
                 WHERE r.task_id = t.task_id
                   AND r.role_code = ANY(CAST(:roleCodes AS text[]))
              )
        ORDER BY t.due_at NULLS LAST, t.task_created_at
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { roleCodes: `{${caller.roleCodes.join(',')}}`, limit },
      },
    );

    return rows.map(toInboxTask);
  }

  /** Open tasks for one case, for the case timeline. */
  async forBusinessKey(businessKey: string): Promise<readonly InboxTask[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT t.task_id, t.process_instance_id, t.business_key, t.step_code,
              t.name, t.assignee, t.due_at, t.task_created_at,
              COALESCE(
                (SELECT json_agg(r.role_code)
                   FROM workflow.active_task_role r
                  WHERE r.task_id = t.task_id),
                '[]'::json
              ) AS role_codes
         FROM workflow.active_task t
        WHERE t.business_key = :businessKey
          AND t.completed_at IS NULL
          AND t.is_active
        ORDER BY t.task_created_at`,
      { type: QueryTypes.SELECT, replacements: { businessKey } },
    );
    return rows.map(toInboxTask);
  }

  /**
   * Claim a task.
   *
   * Authorisation is checked against the read model before the engine is
   * asked, so an unauthorised claim never reaches it.
   */
  async claim(taskId: string, caller: RequestContext): Promise<void> {
    await this.assertCallerMayAct(taskId, caller);
    await this.engine.claimTask(taskId, caller.username ?? String(caller.userId));
    await this.sequelize.query(
      `UPDATE workflow.active_task
          SET assignee = :assignee, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = :taskId`,
      {
        type: QueryTypes.UPDATE,
        replacements: { taskId, assignee: caller.username ?? String(caller.userId) },
      },
    );
  }

  /**
   * Complete a task.
   *
   * The caller must hold one of the task's roles. Note what is *not* checked
   * here: segregation of duties. Reviewer-is-not-preparer is a domain rule
   * about a case, and belongs in the case lifecycle service where the case is
   * in scope (plan 9.3).
   */
  async complete(
    taskId: string,
    stepCode: string,
    actionCode: string,
    data: Readonly<Record<string, unknown>>,
    caller: RequestContext,
  ): Promise<void> {
    await this.assertCallerMayAct(taskId, caller);
    await this.engine.completeTask(taskId, stepCode, actionCode, data);
    // The webhook will also close this task; doing it here means the inbox is
    // correct immediately rather than after the round trip.
    await this.sequelize.query(
      `UPDATE workflow.active_task
          SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
        WHERE task_id = :taskId`,
      { type: QueryTypes.UPDATE, replacements: { taskId } },
    );
  }

  private async assertCallerMayAct(taskId: string, caller: RequestContext): Promise<void> {
    const rows = await this.sequelize.query<{ role_code: string }>(
      `SELECT r.role_code
         FROM workflow.active_task t
         JOIN workflow.active_task_role r ON r.task_id = t.task_id
        WHERE t.task_id = :taskId AND t.completed_at IS NULL`,
      { type: QueryTypes.SELECT, replacements: { taskId } },
    );

    if (rows.length === 0) {
      // Either no such open task, or one with no roles. Both deny, and the
      // message does not distinguish them: whether a task exists is itself
      // information.
      throw new NotFoundException('No such open task');
    }

    const permitted = rows.some((row) => caller.roleCodes.includes(row.role_code));
    if (!permitted) {
      throw new ForbiddenException('This task is assigned to a different role');
    }
  }
}

function toInboxTask(row: Record<string, unknown>): InboxTask {
  const dueAt = row['due_at'] === null ? undefined : (row['due_at'] as Date);
  return {
    taskId: String(row['task_id']),
    processInstanceId: String(row['process_instance_id']),
    businessKey: row['business_key'] === null ? undefined : String(row['business_key']),
    stepCode: row['step_code'] === null ? undefined : String(row['step_code']),
    name: row['name'] === null ? undefined : String(row['name']),
    assignee: row['assignee'] === null ? undefined : String(row['assignee']),
    dueAt,
    createdAt: row['task_created_at'] === null ? undefined : (row['task_created_at'] as Date),
    roleCodes: (row['role_codes'] as string[] | null) ?? [],
    overdue: dueAt !== undefined && dueAt.getTime() < Date.now(),
  };
}
