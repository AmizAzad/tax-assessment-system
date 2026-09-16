'use strict';

/**
 * The workflow read model.
 *
 * Plan reference: V2 sections 5.4, 5.5; ADR-002.
 *
 * Flowable owns its own schema and we never write to it. These tables are a
 * projection fed by engine webhooks, so the register, the task inbox and the
 * audit timeline can be answered in one SQL statement alongside domain data
 * rather than by fanning out to the engine on every screen render.
 *
 * Being a projection, it can lag or diverge. Two things follow, both
 * deliberate:
 *   - a reconciliation job compares it with engine state and alerts
 *   - the domain event ledger, NOT this, is the audit system of record
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('CURRENT_TIMESTAMP');

    const audit = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      created_by: { type: DataTypes.BIGINT, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_by: { type: DataTypes.BIGINT, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    };

    // ------------------------------------------------- definition registry
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'process_definition' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        // Our stable handle. Flowable's definition key and id are generated
        // per deployment and must never be hard-coded anywhere (plan 5.5).
        workflow_code: { type: DataTypes.STRING(64), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'DRAFT' },
        bpmn_xml: { type: DataTypes.TEXT, allowNull: false },
        // Populated on publish, from the engine's deploy response.
        engine_deployment_id: { type: DataTypes.STRING(64), allowNull: true },
        engine_definition_id: { type: DataTypes.STRING(128), allowNull: true },
        engine_definition_key: { type: DataTypes.STRING(128), allowNull: true },
        // The publish-time validation outcome, kept so a reviewer can see what
        // was checked and what warnings were accepted.
        validation_json: { type: DataTypes.JSONB, allowNull: true },
        published_at: { type: DataTypes.DATE, allowNull: true },
        published_by: { type: DataTypes.BIGINT, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'workflow', tableName: 'process_definition' },
      {
        fields: ['workflow_code', 'version'],
        type: 'unique',
        name: 'process_definition_code_version_unique',
      },
    );

    // -------------------------------------------------------- instance state
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'process_snapshot' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        process_instance_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        engine_definition_id: { type: DataTypes.STRING(128), allowNull: true },
        workflow_code: { type: DataTypes.STRING(64), allowNull: true },
        // Always the case number, so objection and appeal processes correlate
        // to their parent case.
        business_key: { type: DataTypes.STRING(64), allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'RUNNING' },
        current_step_code: { type: DataTypes.STRING(64), allowNull: true },
        variables: { type: DataTypes.JSONB, allowNull: true },
        started_at: { type: DataTypes.DATE, allowNull: true },
        ended_at: { type: DataTypes.DATE, allowNull: true },
        // When the last engine event for this instance was applied. A stale
        // value is how the reconciliation job spots a lost webhook.
        last_event_at: { type: DataTypes.DATE, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addIndex(
      { schema: 'workflow', tableName: 'process_snapshot' },
      ['business_key'],
      { name: 'ix_process_snapshot_business_key' },
    );

    // ------------------------------------------------------------ task inbox
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'active_task' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        task_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        process_instance_id: { type: DataTypes.STRING(64), allowNull: false },
        business_key: { type: DataTypes.STRING(64), allowNull: true },
        task_definition_key: { type: DataTypes.STRING(64), allowNull: true },
        step_code: { type: DataTypes.STRING(64), allowNull: true },
        form_template_id: { type: DataTypes.BIGINT, allowNull: true },
        name: { type: DataTypes.STRING(255), allowNull: true },
        assignee: { type: DataTypes.STRING(255), allowNull: true },
        // Populated from the engine's due date. The SLA tracker reads it.
        due_at: { type: DataTypes.DATE, allowNull: true },
        task_created_at: { type: DataTypes.DATE, allowNull: true },
        completed_at: { type: DataTypes.DATE, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_active_task_open
        ON workflow.active_task (business_key, step_code)
        WHERE completed_at IS NULL;
    `);

    // Role codes for a task, normalised so the inbox query is a join rather
    // than a string scan.
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'active_task_role' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        task_id: { type: DataTypes.STRING(64), allowNull: false },
        role_code: { type: DataTypes.STRING(64), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addConstraint(
      { schema: 'workflow', tableName: 'active_task_role' },
      { fields: ['task_id', 'role_code'], type: 'unique', name: 'active_task_role_unique' },
    );

    // ------------------------------------------------------- activity trace
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'activity_progress' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        process_instance_id: { type: DataTypes.STRING(64), allowNull: false },
        activity_id: { type: DataTypes.STRING(128), allowNull: true },
        activity_name: { type: DataTypes.STRING(255), allowNull: true },
        activity_type: { type: DataTypes.STRING(64), allowNull: true },
        event_type: { type: DataTypes.STRING(64), allowNull: false },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addIndex(
      { schema: 'workflow', tableName: 'activity_progress' },
      ['process_instance_id', 'occurred_at'],
      { name: 'ix_activity_progress_instance' },
    );

    // ------------------------------------------------------------ SLA tracker
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'sla_tracker' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        task_id: { type: DataTypes.STRING(64), allowNull: true },
        process_instance_id: { type: DataTypes.STRING(64), allowNull: false },
        business_key: { type: DataTypes.STRING(64), allowNull: true },
        step_code: { type: DataTypes.STRING(64), allowNull: true },
        due_at: { type: DataTypes.DATE, allowNull: false },
        warned_at: { type: DataTypes.DATE, allowNull: true },
        breached_at: { type: DataTypes.DATE, allowNull: true },
        resolved_at: { type: DataTypes.DATE, allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'OPEN' },
        ...audit,
      },
    );
    // The scheduler scans this every few minutes; it must never table-scan.
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_sla_tracker_due
        ON workflow.sla_tracker (due_at)
        WHERE status = 'OPEN';
    `);

    // ------------------------------------------------- webhook event journal
    await queryInterface.createTable(
      { schema: 'workflow', tableName: 'engine_event' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        event_type: { type: DataTypes.STRING(64), allowNull: false },
        process_instance_id: { type: DataTypes.STRING(64), allowNull: true },
        task_id: { type: DataTypes.STRING(64), allowNull: true },
        payload_json: { type: DataTypes.JSONB, allowNull: false },
        // Set when the projection has been applied. An unapplied row is either
        // in flight or evidence of a bug, and either way is worth seeing.
        applied_at: { type: DataTypes.DATE, allowNull: true },
        apply_error: { type: DataTypes.TEXT, allowNull: true },
        received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_engine_event_unapplied
        ON workflow.engine_event (received_at)
        WHERE applied_at IS NULL;
    `);
  },

  async down(queryInterface) {
    for (const tableName of [
      'engine_event',
      'sla_tracker',
      'activity_progress',
      'active_task_role',
      'active_task',
      'process_snapshot',
      'process_definition',
    ]) {
      await queryInterface.dropTable({ schema: 'workflow', tableName });
    }
  },
};
