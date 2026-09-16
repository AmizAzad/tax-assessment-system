'use strict';

/**
 * Audit, localisation, scheduling and reliability infrastructure.
 *
 * Plan reference: V2 sections 6.5, 6.6, 6.7, 6.8, 19.
 *
 * `entity_history` is the generic before/after snapshot store. Registering a
 * table with it is a configuration row, not a bespoke trigger per table, so
 * adding audit to a new table is a seed rather than a migration full of SQL.
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

    // ------------------------------------------------------------ i18n
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'language' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        language_code: { type: DataTypes.STRING(10), allowNull: false, unique: true },
        display_name: { type: DataTypes.STRING(128), allowNull: false },
        // LTR or RTL. Built in from the start: retrofitting RTL costs far more
        // than carrying it (plan section 18.3).
        direction: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'LTR' },
        is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'display_key' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        // e.g. ta.field.assessedAmount, ta.status.UNDER_REVIEW
        key: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        // Notes for translators. A key without context gets mistranslated.
        context: { type: DataTypes.TEXT, allowNull: true },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'display_key_label' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        display_key_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'display_key' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        language_code: { type: DataTypes.STRING(10), allowNull: false },
        label: { type: DataTypes.TEXT, allowNull: false },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'display_key_label' },
      {
        fields: ['display_key_id', 'language_code'],
        type: 'unique',
        name: 'display_key_label_unique',
      },
    );

    // ---------------------------------------------------------- entity history
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'entity_history_config' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        schema_name: { type: DataTypes.STRING(64), allowNull: false },
        table_name: { type: DataTypes.STRING(64), allowNull: false },
        // Columns never snapshotted: secrets, and large payloads that would
        // bloat the history store without adding audit value.
        excluded_columns: { type: DataTypes.JSONB, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'entity_history_config' },
      {
        fields: ['schema_name', 'table_name'],
        type: 'unique',
        name: 'entity_history_config_unique',
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'entity_history' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        schema_name: { type: DataTypes.STRING(64), allowNull: false },
        table_name: { type: DataTypes.STRING(64), allowNull: false },
        record_id: { type: DataTypes.BIGINT, allowNull: false },
        operation: { type: DataTypes.STRING(16), allowNull: false },
        before_json: { type: DataTypes.JSONB, allowNull: true },
        after_json: { type: DataTypes.JSONB, allowNull: true },
        // Only the columns that actually changed, so a reviewer does not have
        // to diff two large objects by eye.
        changed_columns: { type: DataTypes.JSONB, allowNull: true },
        actor_user_id: { type: DataTypes.BIGINT, allowNull: true },
        correlation_id: { type: DataTypes.STRING(64), allowNull: true },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'entity_history' },
      ['schema_name', 'table_name', 'record_id', 'occurred_at'],
      { name: 'ix_entity_history_record' },
    );

    // ------------------------------------------------------------- api trace
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'api_trace_log' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        correlation_id: { type: DataTypes.STRING(64), allowNull: false },
        method: { type: DataTypes.STRING(10), allowNull: false },
        path: { type: DataTypes.STRING(512), allowNull: false },
        status_code: { type: DataTypes.INTEGER, allowNull: true },
        actor_user_id: { type: DataTypes.BIGINT, allowNull: true },
        actor_roles: { type: DataTypes.JSONB, allowNull: true },
        duration_ms: { type: DataTypes.INTEGER, allowNull: true },
        // Redacted by an explicit field allowlist. Taxpayer financial data
        // must never reach this table (plan section 19.2).
        request_summary: { type: DataTypes.JSONB, allowNull: true },
        ip_address: { type: DataTypes.STRING(64), allowNull: true },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'api_trace_log' },
      ['correlation_id'],
      { name: 'ix_api_trace_correlation' },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'api_trace_log' },
      ['actor_user_id', 'occurred_at'],
      { name: 'ix_api_trace_actor' },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'exception_log' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        correlation_id: { type: DataTypes.STRING(64), allowNull: true },
        error_code: { type: DataTypes.STRING(64), allowNull: true },
        message: { type: DataTypes.TEXT, allowNull: false },
        stack: { type: DataTypes.TEXT, allowNull: true },
        context_json: { type: DataTypes.JSONB, allowNull: true },
        actor_user_id: { type: DataTypes.BIGINT, allowNull: true },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );

    // ----------------------------------------------------- scheduling / retry
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'scheduled_job' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        job_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        cron_expression: { type: DataTypes.STRING(64), allowNull: false },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        last_run_at: { type: DataTypes.DATE, allowNull: true },
        last_status: { type: DataTypes.STRING(32), allowNull: true },
        last_error: { type: DataTypes.TEXT, allowNull: true },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'idempotency_key' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        operation: { type: DataTypes.STRING(64), allowNull: false },
        idempotency_key: { type: DataTypes.STRING(128), allowNull: false },
        // A replayed request with the same key returns the stored result
        // rather than issuing a second notice or posting a second liability.
        result_hash: { type: DataTypes.STRING(64), allowNull: true },
        result_json: { type: DataTypes.JSONB, allowNull: true },
        expires_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'idempotency_key' },
      {
        fields: ['operation', 'idempotency_key'],
        type: 'unique',
        name: 'idempotency_key_unique',
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'suspended_operation' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        operation: { type: DataTypes.STRING(64), allowNull: false },
        target_reference: { type: DataTypes.STRING(128), allowNull: true },
        payload_json: { type: DataTypes.JSONB, allowNull: false },
        attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        last_error: { type: DataTypes.TEXT, allowNull: true },
        next_attempt_at: { type: DataTypes.DATE, allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING' },
        ...audit,
      },
    );
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_suspended_operation_due
        ON platform.suspended_operation (next_attempt_at)
        WHERE status = 'PENDING';
    `);

    // ---------------------------------------------------------------- grids
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'grid_definition' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        grid_key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        // Column definitions are configuration: register columns change per
        // deployment without a release.
        column_defs: { type: DataTypes.JSONB, allowNull: false },
        default_sort: { type: DataTypes.STRING(128), allowNull: true },
        ...audit,
      },
    );

    // ---------------------------------------------------------------- seeds
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'language' }, [
      { language_code: 'en', display_name: 'English', direction: 'LTR', is_default: true },
      { language_code: 'ar', display_name: 'العربية', direction: 'RTL', is_default: false },
    ]);

    // Tables whose changes must be snapshotted. Adding one later is a seed row.
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'entity_history_config' }, [
      { schema_name: 'tax', table_name: 'tax_assessment_case', excluded_columns: null },
      { schema_name: 'platform', table_name: 'taxpayer', excluded_columns: null },
      { schema_name: 'platform', table_name: 'role_permission', excluded_columns: null },
      { schema_name: 'platform', table_name: 'user_role', excluded_columns: null },
      { schema_name: 'platform', table_name: 'delegation', excluded_columns: null },
    ]);
  },

  async down(queryInterface) {
    for (const tableName of [
      'grid_definition',
      'suspended_operation',
      'idempotency_key',
      'scheduled_job',
      'exception_log',
      'api_trace_log',
      'entity_history',
      'entity_history_config',
      'display_key_label',
      'display_key',
      'language',
    ]) {
      await queryInterface.dropTable({ schema: 'platform', tableName });
    }
  },
};
