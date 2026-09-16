import { Sequelize } from 'sequelize';
import { EngineEventService } from '../src/workflow/engine-event.service';

/**
 * Webhook ingestion, against a real database.
 *
 * Plan reference: V2 sections 5.4, 5.5.
 *
 * Run with `npm run dev:up`. These assert the projection actually lands,
 * because a read model that silently fails to update is the exact failure the
 * reconciliation job exists to catch -- and it is better caught here.
 */

const sequelize = new Sequelize({
  dialect: 'postgres',
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? 5433),
  username: process.env['DB_USER'] ?? 'tas',
  password: process.env['DB_PASSWORD'] ?? 'tas_local_dev_only',
  database: process.env['DB_NAME'] ?? 'tax_assessment',
  logging: false,
});

const service = new EngineEventService(sequelize);

const INSTANCE = `test-proc-${Date.now()}`;
const TASK = `test-task-${Date.now()}`;
const BUSINESS_KEY = `TA-TEST-${Date.now()}`;

async function cleanUp(): Promise<void> {
  for (const statement of [
    `DELETE FROM workflow.sla_tracker WHERE process_instance_id LIKE 'test-proc-%'`,
    `DELETE FROM workflow.active_task_role WHERE task_id LIKE 'test-task-%'`,
    `DELETE FROM workflow.active_task WHERE process_instance_id LIKE 'test-proc-%'`,
    `DELETE FROM workflow.activity_progress WHERE process_instance_id LIKE 'test-proc-%'`,
    `DELETE FROM workflow.process_snapshot WHERE process_instance_id LIKE 'test-proc-%'`,
    `DELETE FROM workflow.engine_event WHERE process_instance_id LIKE 'test-proc-%'`,
  ]) {
    await sequelize.query(statement);
  }
}

beforeAll(async () => {
  await sequelize.authenticate();
  await cleanUp();
});

afterAll(async () => {
  await cleanUp();
  await sequelize.close();
});

describe('engine event ingestion', () => {
  it('rejects an event with no type', async () => {
    const outcome = await service.ingest({ eventType: '' });
    expect(outcome.accepted).toBe(false);
  });

  it('projects PROCESS_STARTED into a snapshot', async () => {
    const outcome = await service.ingest({
      eventType: 'PROCESS_STARTED',
      processInstanceId: INSTANCE,
      processDefinitionKey: 'TAX_ASSESSMENT_MAIN',
      businessKey: BUSINESS_KEY,
      occurredAt: new Date().toISOString(),
    });
    expect(outcome).toMatchObject({ accepted: true, applied: true });

    const [rows] = await sequelize.query(
      `SELECT status, business_key, workflow_code FROM workflow.process_snapshot
        WHERE process_instance_id = '${INSTANCE}'`,
    );
    expect(rows[0]).toMatchObject({
      status: 'RUNNING',
      business_key: BUSINESS_KEY,
      workflow_code: 'TAX_ASSESSMENT_MAIN',
    });
  });

  it('journals every event, applied or not', async () => {
    const [rows] = await sequelize.query(
      `SELECT count(*)::int AS n FROM workflow.engine_event
        WHERE process_instance_id = '${INSTANCE}'`,
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it('opens a task and creates an SLA row when a due date is present', async () => {
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    await service.ingest({
      eventType: 'TASK_CREATED',
      processInstanceId: INSTANCE,
      businessKey: BUSINESS_KEY,
      taskId: TASK,
      taskName: 'Review Assessment',
      taskDefinitionKey: 'TA_REVIEW',
      dueDate: dueAt,
      occurredAt: new Date().toISOString(),
    });

    const [tasks] = await sequelize.query(
      `SELECT step_code, name, completed_at FROM workflow.active_task WHERE task_id = '${TASK}'`,
    );
    expect(tasks[0]).toMatchObject({
      step_code: 'TA_REVIEW',
      name: 'Review Assessment',
      completed_at: null,
    });

    const [sla] = await sequelize.query(
      `SELECT status, resolved_at FROM workflow.sla_tracker WHERE task_id = '${TASK}'`,
    );
    expect(sla[0]).toMatchObject({ status: 'OPEN', resolved_at: null });
  });

  it('is idempotent on a repeated TASK_CREATED', async () => {
    // A redelivered webhook must not create a second inbox row.
    await service.ingest({
      eventType: 'TASK_CREATED',
      processInstanceId: INSTANCE,
      businessKey: BUSINESS_KEY,
      taskId: TASK,
      taskDefinitionKey: 'TA_REVIEW',
      occurredAt: new Date().toISOString(),
    });

    const [rows] = await sequelize.query(
      `SELECT count(*)::int AS n FROM workflow.active_task WHERE task_id = '${TASK}'`,
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('records activity progress and advances the current step', async () => {
    await service.ingest({
      eventType: 'ACTIVITY_STARTED',
      processInstanceId: INSTANCE,
      activityId: 'TA_REVIEW',
      activityName: 'Review',
      activityType: 'userTask',
      occurredAt: new Date().toISOString(),
    });

    const [progress] = await sequelize.query(
      `SELECT activity_id, event_type FROM workflow.activity_progress
        WHERE process_instance_id = '${INSTANCE}'`,
    );
    expect(progress[0]).toMatchObject({ activity_id: 'TA_REVIEW', event_type: 'ACTIVITY_STARTED' });

    const [snapshot] = await sequelize.query(
      `SELECT current_step_code FROM workflow.process_snapshot
        WHERE process_instance_id = '${INSTANCE}'`,
    );
    expect(snapshot[0]).toMatchObject({ current_step_code: 'TA_REVIEW' });
  });

  it('closes the task and marks the SLA met on completion', async () => {
    await service.ingest({
      eventType: 'TASK_COMPLETED',
      processInstanceId: INSTANCE,
      taskId: TASK,
      occurredAt: new Date().toISOString(),
    });

    const [tasks] = await sequelize.query(
      `SELECT completed_at FROM workflow.active_task WHERE task_id = '${TASK}'`,
    );
    expect((tasks[0] as { completed_at: Date | null }).completed_at).not.toBeNull();

    const [sla] = await sequelize.query(
      `SELECT status FROM workflow.sla_tracker WHERE task_id = '${TASK}'`,
    );
    // Completed before the due date, so the SLA was met rather than breached.
    expect(sla[0]).toMatchObject({ status: 'MET' });
  });

  it('ends the snapshot on PROCESS_COMPLETED', async () => {
    await service.ingest({
      eventType: 'PROCESS_COMPLETED',
      processInstanceId: INSTANCE,
      businessKey: BUSINESS_KEY,
      occurredAt: new Date().toISOString(),
    });

    const [rows] = await sequelize.query(
      `SELECT status, ended_at FROM workflow.process_snapshot
        WHERE process_instance_id = '${INSTANCE}'`,
    );
    expect(rows[0]).toMatchObject({ status: 'COMPLETED' });
    expect((rows[0] as { ended_at: Date | null }).ended_at).not.toBeNull();
  });

  it('accepts an unknown event type without applying it', async () => {
    // Rejecting would make the engine retry forever for something we have
    // deliberately chosen not to project.
    const outcome = await service.ingest({
      eventType: 'SOME_FUTURE_EVENT',
      processInstanceId: INSTANCE,
    });
    expect(outcome).toMatchObject({ accepted: true, applied: false });
  });

  it('tolerates a completed process whose start event was never delivered', async () => {
    // The lost-webhook case. A projection that only handled the happy ordering
    // would leave no trace of the instance at all.
    const orphan = `test-proc-orphan-${Date.now()}`;
    await service.ingest({
      eventType: 'PROCESS_COMPLETED',
      processInstanceId: orphan,
      businessKey: 'TA-ORPHAN',
      occurredAt: new Date().toISOString(),
    });

    const [rows] = await sequelize.query(
      `SELECT status FROM workflow.process_snapshot WHERE process_instance_id = '${orphan}'`,
    );
    expect(rows[0]).toMatchObject({ status: 'COMPLETED' });

    await sequelize.query(
      `DELETE FROM workflow.process_snapshot WHERE process_instance_id = '${orphan}'`,
    );
    await sequelize.query(
      `DELETE FROM workflow.engine_event WHERE process_instance_id = '${orphan}'`,
    );
  });
});
