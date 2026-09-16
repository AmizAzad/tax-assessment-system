import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../infrastructure/tokens';

export interface DeployResult {
  readonly deploymentId: string;
  readonly processDefinitionId: string;
  readonly processDefinitionKey: string;
  readonly version: number;
}

export interface StartResult {
  readonly processInstanceId: string;
  readonly processDefinitionId: string;
  readonly businessKey: string;
  readonly ended: boolean;
}

export interface EngineTask {
  readonly taskId: string;
  readonly name?: string;
  readonly taskDefinitionKey?: string;
  readonly processInstanceId: string;
  readonly assignee?: string;
  readonly dueDate?: string;
}

export class EngineUnavailableError extends ServiceUnavailableException {
  constructor(operation: string, cause: string) {
    super(`The workflow engine could not ${operation}: ${cause}`);
  }
}

/**
 * HTTP client for the BPMN engine.
 *
 * Plan reference: V2 sections 5.1, 5.5; ADR-002.
 *
 * ## The engine is never queried on a read path
 *
 * This client deploys, starts, completes and correlates — all write
 * operations. The register and the task inbox are served from the read model
 * (`workflow.*`), because making an interactive screen depend on a second
 * service's availability and latency is a bad trade for data we already have.
 *
 * `listTasks` exists for reconciliation only, and says so.
 *
 * ## Definition keys are never hard-coded
 *
 * Flowable generates a definition key and id per deployment. Callers pass our
 * stable `workflow_code`; the registry resolves it to whatever the engine
 * called it this time (plan 5.5).
 */
@Injectable()
export class EngineClientService {
  private readonly logger = new Logger(EngineClientService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs = 15_000;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.baseUrl = config.bpmnEngineUrl.replace(/\/+$/, '');
  }

  async deploy(name: string, bpmnXml: string): Promise<DeployResult> {
    const response = await this.call(
      'deploy a definition',
      `/api/process/deploy?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: bpmnXml },
    );
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      deploymentId: String(payload['deploymentId']),
      processDefinitionId: String(payload['processDefinitionId']),
      processDefinitionKey: String(payload['processDefinitionKey']),
      version: Number(payload['version']),
    };
  }

  /**
   * Start an instance.
   *
   * `businessKey` is always the case number, so objection and appeal
   * processes correlate back to their parent case (plan 5.2).
   */
  async start(
    processDefinitionKey: string,
    businessKey: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<StartResult> {
    const response = await this.call('start an instance', '/api/process/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processDefinitionKey, businessKey, variables }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      processInstanceId: String(payload['processInstanceId']),
      processDefinitionId: String(payload['processDefinitionId']),
      businessKey,
      ended: payload['ended'] === true,
    };
  }

  /**
   * Complete a user task.
   *
   * The caller has already persisted the submission and written the domain
   * event in its own transaction. If this then fails, the reconciliation job
   * detects the divergence — the accepted trade-off of an engine that owns
   * state we do not (ADR-002).
   */
  async completeTask(
    taskId: string,
    stepCode: string,
    actionCode: string,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.call('complete a task', `/api/task/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepCode, actionCode, data }),
    });
  }

  async claimTask(taskId: string, assignee: string): Promise<void> {
    await this.call(
      'claim a task',
      `/api/task/${encodeURIComponent(taskId)}/claim?assignee=${encodeURIComponent(assignee)}`,
      { method: 'POST' },
    );
  }

  /** Deliver a message to a waiting instance, e.g. a taxpayer response. */
  async sendMessage(
    processInstanceId: string,
    messageName: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.call(
      'deliver a message',
      `/api/process/${encodeURIComponent(processInstanceId)}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageName, variables }),
      },
    );
  }

  async cancel(processInstanceId: string, reason: string): Promise<void> {
    await this.call(
      'cancel an instance',
      `/api/process/${encodeURIComponent(processInstanceId)}?reason=${encodeURIComponent(reason)}`,
      { method: 'DELETE' },
    );
  }

  async variables(processInstanceId: string): Promise<Record<string, unknown>> {
    const response = await this.call(
      'read instance variables',
      `/api/process/${encodeURIComponent(processInstanceId)}/variables`,
      { method: 'GET' },
    );
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Tasks the engine believes are open for an instance.
   *
   * **For reconciliation only.** The inbox reads `workflow.active_task`.
   */
  async listTasks(processInstanceId: string): Promise<readonly EngineTask[]> {
    const response = await this.call(
      'list tasks',
      `/api/task?processInstanceId=${encodeURIComponent(processInstanceId)}`,
      { method: 'GET' },
    );
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    return payload.map((task) => ({
      taskId: String(task['taskId']),
      name: task['name'] === null ? undefined : String(task['name']),
      taskDefinitionKey:
        task['taskDefinitionKey'] === null ? undefined : String(task['taskDefinitionKey']),
      processInstanceId: String(task['processInstanceId']),
      assignee: task['assignee'] === null ? undefined : String(task['assignee']),
      dueDate: task['dueDate'] === null ? undefined : String(task['dueDate']),
    }));
  }

  /** Whether the engine is reachable. Used by readiness and reconciliation. */
  async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/actuator/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async call(operation: string, path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : 'unknown transport error';
      this.logger.error(`Engine call failed (${operation}): ${cause}`);
      throw new EngineUnavailableError(operation, cause);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Engine returned ${response.status} for ${operation}: ${body.slice(0, 500)}`,
      );
      throw new EngineUnavailableError(operation, `HTTP ${response.status}`);
    }

    return response;
  }
}
