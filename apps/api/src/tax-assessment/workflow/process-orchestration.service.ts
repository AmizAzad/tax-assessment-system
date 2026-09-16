import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { EngineClientService } from '../../workflow/engine-client.service';
import { withDiagram } from '../../workflow/bpmn-layout';
import { currentUserId } from '../../platform/auth/request-context';
import type { AssessmentCase } from '../case/case.service';

/**
 * Connecting a case to its process instance.
 *
 * Plan reference: V2 sections 5.1 to 5.4; ADR-002.
 *
 * ## The division of responsibility, restated
 *
 * The case machine owns status. The engine owns *coordination*: who is asked
 * to act, in what order, and what happens when nobody does. This service is
 * the seam between them, and it only ever pushes: the API tells the engine
 * what happened, and never asks the engine what a case's status is.
 *
 * Until now the seam was one-way in the other direction — the engine called
 * the API through `apiInvoker`, but nothing started a process, so the task
 * inbox was permanently empty and the whole engine was inert.
 *
 * ## Why every failure here is swallowed
 *
 * An unreachable engine must not stop an assessment. A case that cannot be
 * coordinated is worked by hand; a case that cannot be *opened* is a taxpayer
 * who is not assessed. So every call is attempted, logged on failure, and the
 * reconciliation job picks up the divergence later.
 *
 * That is the accepted trade-off of an engine that owns state we do not, and
 * it is why `ProcessOrchestrationService` never throws.
 */
@Injectable()
export class ProcessOrchestrationService {
  private readonly logger = new Logger(ProcessOrchestrationService.name);

  /** The definition every assessment runs under. */
  static readonly MAIN_PROCESS = 'TAX_ASSESSMENT_MAIN';

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly engine: EngineClientService,
  ) {}

  /**
   * Start the process for a newly opened case.
   *
   * The case number is the business key, so a human holding a case reference
   * can always find the instance, and the engine can always be correlated back
   * without a lookup table.
   */
  async onCaseOpened(assessmentCase: AssessmentCase): Promise<void> {
    try {
      const started = await this.engine.start(
        ProcessOrchestrationService.MAIN_PROCESS,
        assessmentCase.caseNumber,
        {
          caseId: assessmentCase.id,
          caseNumber: assessmentCase.caseNumber,
          taxpayerId: assessmentCase.taxpayerId,
          tin: assessmentCase.tin,
          taxTypeCode: assessmentCase.taxTypeCode,
          assessmentYear: assessmentCase.assessmentYear,
          jurisdictionCode: assessmentCase.jurisdictionCode,
        },
      );

      await this.link(assessmentCase.id, started.processInstanceId);
      this.logger.log(
        `Case ${assessmentCase.caseNumber} coordinated by process ${started.processInstanceId}`,
      );
    } catch (error) {
      // Logged, never raised. See the class note: a case that cannot be
      // coordinated is worked by hand.
      this.logger.warn(
        `Case ${assessmentCase.caseNumber} opened without a process instance: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'The reconciliation job will report the divergence.',
      );
    }
  }

  /**
   * Tell the engine a case has moved.
   *
   * Sent as a message rather than by completing a task, because the API does
   * not know which engine task is open and should not have to. The process
   * decides what a given message means to it, which is the point of modelling
   * coordination separately.
   */
  async onTransition(
    assessmentCase: { id: number; caseNumber: string },
    action: string,
    toStatus: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const processInstanceId = await this.processFor(assessmentCase.id);
    if (processInstanceId === undefined) return;

    try {
      await this.engine.sendMessage(processInstanceId, `CASE_${action}`, {
        ...variables,
        statusCode: toStatus,
        caseId: assessmentCase.id,
      });
    } catch (error) {
      // A message the process does not correlate is normal: most transitions
      // have no meaning to the diagram. Only a genuine transport failure is
      // worth a line, and even that is not worth failing a transition over.
      this.logger.debug(
        `Message CASE_${action} not delivered for ${assessmentCase.caseNumber}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Cancel the instance when a case ends without completing the flow.
   *
   * A cancelled or written-off case leaves a process instance waiting on a
   * task nobody will ever do. Those are the instances that accumulate until an
   * engine's task tables are mostly ghosts.
   */
  async onCaseClosed(
    assessmentCase: { id: number; caseNumber: string },
    reason: string,
  ): Promise<void> {
    const processInstanceId = await this.processFor(assessmentCase.id);
    if (processInstanceId === undefined) return;

    try {
      await this.engine.cancel(processInstanceId, reason);
      this.logger.log(`Process for ${assessmentCase.caseNumber} cancelled: ${reason}`);
    } catch (error) {
      this.logger.warn(
        `Could not cancel the process for ${assessmentCase.caseNumber}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Deploy the assessment process definition.
   *
   * Called from the deployment endpoint rather than on boot: a definition must
   * pass the publish-time role check first, and deploying automatically would
   * mean an edited file reaching the engine without anybody approving it.
   */
  async deploy(
    name: string,
    bpmnXml: string,
  ): Promise<{ deploymentId: string; processDefinitionKey: string; version: number }> {
    const result = await this.engine.deploy(name, bpmnXml);
    this.logger.log(
      `Deployed ${name}: ${result.processDefinitionKey} v${result.version} ` +
        `(${result.deploymentId})`,
    );

    await this.record(name, bpmnXml, result);

    return {
      deploymentId: result.deploymentId,
      processDefinitionKey: result.processDefinitionKey,
      version: result.version,
    };
  }

  /**
   * Keep our own copy of what was deployed.
   *
   * Plan reference: V2 section 5.4 (runtime read model).
   *
   * The engine holds the definition it is executing. That is not enough:
   * drawing a case's journey, showing an author what is live, and answering
   * "what did this case run under" all need the XML, and all of them would
   * then be unavailable whenever the engine is restarting or unreachable.
   *
   * Recorded after the engine accepted it, never before. A row here claiming
   * a definition is published when the engine refused it would be a lie told
   * by our own read model.
   */
  private async record(
    workflowCode: string,
    bpmnXml: string,
    result: { deploymentId: string; processDefinitionKey: string; version: number },
  ): Promise<void> {
    try {
      await this.sequelize.query(
        `INSERT INTO workflow.process_definition
                (workflow_code, version, display_key, status, bpmn_xml,
                 engine_deployment_id, engine_definition_key, published_at,
                 published_by, created_by, updated_by)
         VALUES (:workflowCode, :version, :displayKey, 'PUBLISHED', :bpmnXml,
                 :deploymentId, :definitionKey, CURRENT_TIMESTAMP,
                 :userId, :userId, :userId)
         ON CONFLICT (workflow_code, version) DO UPDATE
            SET bpmn_xml = EXCLUDED.bpmn_xml,
                status = 'PUBLISHED',
                engine_deployment_id = EXCLUDED.engine_deployment_id,
                engine_definition_key = EXCLUDED.engine_definition_key,
                published_at = CURRENT_TIMESTAMP,
                published_by = EXCLUDED.published_by,
                updated_at = CURRENT_TIMESTAMP`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            workflowCode,
            version: result.version,
            displayKey: `ta.process.${workflowCode.toLowerCase()}`,
            bpmnXml,
            deploymentId: result.deploymentId,
            definitionKey: result.processDefinitionKey,
            userId: currentUserId() ?? null,
          },
        },
      );
    } catch (error) {
      // Logged, not raised. The deployment has happened — the engine has the
      // definition and cases will run under it. Failing the request now would
      // report a failure that did not occur and invite a second deployment.
      this.logger.error(
        `Deployed ${workflowCode} v${result.version} but could not record it locally: ` +
          `${error instanceof Error ? error.message : 'unknown error'}. ` +
          'The journey view will have no diagram for it.',
      );
    }
  }

  /**
   * What is coordinating this case, if anything.
   *
   * Returns the absence explicitly rather than an empty object, because "no
   * process" is a real and common answer -- a case opened while the engine was
   * unreachable is worked perfectly well by hand -- and a screen needs to say
   * so rather than show a blank panel.
   */
  async instanceFor(caseId: number): Promise<{
    processInstanceId: string | null;
    coordinated: boolean;
  }> {
    const processInstanceId = await this.processFor(caseId);
    return {
      processInstanceId: processInstanceId ?? null,
      coordinated: processInstanceId !== undefined,
    };
  }

  /**
   * The published XML of a definition, for a diagram viewer.
   *
   * Read from our own registry rather than the engine. The registry row is
   * what was validated and approved, and it is available whether or not the
   * engine is reachable — a journey screen that goes blank because the engine
   * is restarting would be reporting the wrong problem.
   */
  async definitionXml(workflowCode: string): Promise<{
    workflowCode: string;
    version: number;
    status: string;
    bpmnXml: string;
  }> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT workflow_code, version, status, bpmn_xml
         FROM workflow.process_definition
        WHERE workflow_code = :workflowCode AND is_active
        ORDER BY CASE WHEN status = 'PUBLISHED' THEN 0 ELSE 1 END, version DESC
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { workflowCode } },
    );

    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`No process definition is registered as '${workflowCode}'`);
    }

    return {
      workflowCode: String(row['workflow_code']),
      version: Number(row['version']),
      status: String(row['status']),
      // Laid out if the author wrote no coordinates, which is the normal case
      // for a definition reviewed as text. The stored XML is untouched.
      bpmnXml: withDiagram(String(row['bpmn_xml'])),
    };
  }

  /**
   * Where a case has reached in its process.
   *
   * Returns the diagram and the activity ids to overlay on it: what has
   * finished, what is running now, and the ordered history behind both.
   *
   * ## Why "active" is derived rather than stored
   *
   * The engine tells us when an activity starts and when it ends. Holding a
   * separate "currently active" list would be a third copy of a fact the
   * event stream already carries, and the copy is the thing that goes stale
   * when an event is missed. Deriving it means the screen is wrong only if
   * the history is wrong, which is visible.
   */
  async journey(caseId: number): Promise<{
    processInstanceId: string | null;
    coordinated: boolean;
    workflowCode: string | null;
    bpmnXml: string | null;
    completed: readonly string[];
    active: readonly string[];
    history: readonly Record<string, unknown>[];
  }> {
    const processInstanceId = await this.processFor(caseId);

    if (processInstanceId === undefined) {
      // Not an error. A case opened while the engine was unreachable is
      // worked by hand, and the screen has to say that rather than fail.
      return {
        processInstanceId: null,
        coordinated: false,
        workflowCode: null,
        bpmnXml: null,
        completed: [],
        active: [],
        history: [],
      };
    }

    const history = await this.sequelize.query<Record<string, unknown>>(
      `SELECT activity_id AS "activityId", activity_name AS "activityName",
              activity_type AS "activityType", event_type AS "eventType",
              occurred_at AS "occurredAt"
         FROM workflow.activity_progress
        WHERE process_instance_id = :processInstanceId
        ORDER BY occurred_at, id`,
      { type: QueryTypes.SELECT, replacements: { processInstanceId } },
    );

    const started = new Set<string>();
    const completed = new Set<string>();
    for (const entry of history) {
      const activityId = entry['activityId'];
      if (typeof activityId !== 'string') {
        continue;
      }
      const eventType = String(entry['eventType']).toUpperCase();
      if (eventType.includes('COMPLET') || eventType.includes('END')) {
        completed.add(activityId);
      } else {
        started.add(activityId);
      }
    }

    const definition = await this.definitionForInstance(caseId);

    return {
      processInstanceId,
      coordinated: true,
      workflowCode: definition?.workflowCode ?? null,
      bpmnXml: definition?.bpmnXml ?? null,
      completed: [...completed],
      active: [...started].filter((activityId) => !completed.has(activityId)),
      history,
    };
  }

  // ------------------------------------------------------------------ internals

  /**
   * Record which instance coordinates which case.
   *
   * On the case row rather than in a join table: it is exactly one instance
   * per case, and the read path is always "given this case, which process".
   */
  private async link(caseId: number, processInstanceId: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE tax.tax_assessment_case
          SET process_instance_id = :processInstanceId, updated_at = CURRENT_TIMESTAMP
        WHERE id = :caseId`,
      { type: QueryTypes.UPDATE, replacements: { caseId, processInstanceId } },
    );
  }

  /**
   * The definition a case is running under.
   *
   * The case records the version it started with, so a case opened under v2
   * keeps showing v2's diagram after v3 is published. A journey drawn on the
   * wrong diagram puts the marker on the wrong box, which is worse than no
   * diagram at all.
   */
  private async definitionForInstance(
    caseId: number,
  ): Promise<{ workflowCode: string; bpmnXml: string } | undefined> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT d.workflow_code, d.bpmn_xml
         FROM tax.tax_assessment_case c
         JOIN workflow.process_definition d
           ON d.is_active
          AND (c.process_definition_version IS NULL
               OR d.engine_definition_id = c.process_definition_version
               OR d.version::text = c.process_definition_version)
        WHERE c.id = :caseId
        ORDER BY CASE WHEN d.engine_definition_id = c.process_definition_version THEN 0 ELSE 1 END,
                 d.version DESC
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          workflowCode: String(row['workflow_code']),
          bpmnXml: withDiagram(String(row['bpmn_xml'])),
        };
  }

  private async processFor(caseId: number): Promise<string | undefined> {
    const rows = await this.sequelize.query<{ process_instance_id: string | null }>(
      `SELECT process_instance_id FROM tax.tax_assessment_case WHERE id = :caseId`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    return rows[0]?.process_instance_id ?? undefined;
  }
}
