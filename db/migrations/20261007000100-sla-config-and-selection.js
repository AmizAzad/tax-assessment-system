'use strict';

/**
 * SLA definitions, risk-based selection, and the objection deposit.
 *
 * Plan reference: V2 sections 8.1, 10.5, 13.2.
 *
 * ## Three gaps this closes
 *
 * `tax_sla_tracker` and its sweeper were built in Phase 5, but nothing ever
 * created a row: the sweeper watched an empty table. An SLA needs a definition
 * -- which stage, how long, warn when -- before anything can start a clock.
 *
 * `tax_assessment_selection_run` has existed since the Phase 2 schema with no
 * service behind it, so every case had to be opened by hand. Risk-based
 * selection is how a real authority decides who to assess.
 *
 * The objection deposit columns existed with no configuration saying when a
 * deposit is required or how much, so a jurisdiction that requires one could
 * not be modelled.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { BIGINT, INTEGER, STRING, DECIMAL, DATE, DATEONLY, BOOLEAN, TEXT, JSONB } = Sequelize;

    /**
     * What an SLA means, per jurisdiction.
     *
     * A clock starts when a case enters `from_status` and stops when it leaves
     * it (or reaches `stop_status`). Target and warning are working days,
     * because an internal service standard that counted weekends would breach
     * over every holiday.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_sla_config' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: STRING(3), allowNull: false },
        tax_type_code: { type: STRING(20), allowNull: true },
        sla_code: { type: STRING(40), allowNull: false },
        display_key: { type: STRING(200), allowNull: true },

        from_status: { type: STRING(40), allowNull: false },
        /** Null means "any move out of from_status stops the clock". */
        stop_status: { type: STRING(40), allowNull: true },

        target_value: { type: INTEGER, allowNull: false },
        target_unit: { type: STRING(10), allowNull: false, defaultValue: 'DAYS' },
        calendar_rule: { type: STRING(20), allowNull: false, defaultValue: 'BUSINESS_DAYS' },
        /** How long before the target a warning is raised. */
        warn_before_value: { type: INTEGER, allowNull: false, defaultValue: 2 },

        effective_from: { type: DATEONLY, allowNull: true },
        effective_to: { type: DATEONLY, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_sla_config_stage
        ON tax.tax_sla_config (jurisdiction_code, sla_code)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_sla_config
        ADD CONSTRAINT sla_warn_before_target
        CHECK (warn_before_value >= 0 AND warn_before_value < target_value)
    `);

    /**
     * Service standards for the demonstration jurisdictions.
     *
     * Administrative targets, not statutory dates. They are deliberately
     * separate from `tax_deadline_config` so that a missed internal standard
     * can never be argued as a time bar, and a statutory date can never be
     * quietly relaxed as a service target.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_sla_config
        (jurisdiction_code, tax_type_code, sla_code, display_key, from_status, stop_status,
         target_value, target_unit, calendar_rule, warn_before_value, effective_from,
         created_at, updated_at, is_active)
      VALUES
        ('GB', 'CIT', 'PREPARATION', 'ta.sla.preparation', 'IN_PREPARATION',   'CALCULATED',       20, 'DAYS', 'BUSINESS_DAYS', 5, '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'REVIEW',      'ta.sla.review',      'UNDER_REVIEW',     'REVIEWED',          5, 'DAYS', 'BUSINESS_DAYS', 2, '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'APPROVAL',    'ta.sla.approval',    'PENDING_APPROVAL', 'APPROVED',          5, 'DAYS', 'BUSINESS_DAYS', 2, '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'OBJECTION',   'ta.sla.objection',   'UNDER_OBJECTION',  NULL,               45, 'DAYS', 'BUSINESS_DAYS', 10, '2023-04-01', now(), now(), true),
        ('SA', 'CIT', 'PREPARATION', 'ta.sla.preparation', 'IN_PREPARATION',   'CALCULATED',       30, 'DAYS', 'BUSINESS_DAYS', 5, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'REVIEW',      'ta.sla.review',      'UNDER_REVIEW',     'REVIEWED',         10, 'DAYS', 'BUSINESS_DAYS', 3, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'APPROVAL',    'ta.sla.approval',    'PENDING_APPROVAL', 'APPROVED',         10, 'DAYS', 'BUSINESS_DAYS', 3, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'OBJECTION',   'ta.sla.objection',   'UNDER_OBJECTION',  NULL,               60, 'DAYS', 'BUSINESS_DAYS', 10, '2024-01-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // ------------------------------------------------------- risk selection

    /**
     * A risk rule: a named, weighted predicate over a taxpayer period.
     *
     * SQL fragments are **not** accepted here. The `indicator_code` names a
     * check the platform implements, and the parameters tune it. A rule table
     * that accepted arbitrary SQL would be a remote code execution hole
     * wearing a configuration costume.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_risk_rule' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: STRING(3), allowNull: false },
        tax_type_code: { type: STRING(20), allowNull: false },
        rule_code: { type: STRING(40), allowNull: false },
        display_key: { type: STRING(200), allowNull: true },
        indicator_code: { type: STRING(40), allowNull: false },
        parameters_json: { type: JSONB, allowNull: false, defaultValue: {} },
        weight: { type: INTEGER, allowNull: false, defaultValue: 10 },
        is_mandatory_referral: { type: BOOLEAN, allowNull: false, defaultValue: false },
        effective_from: { type: DATEONLY, allowNull: true },
        effective_to: { type: DATEONLY, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_risk_rule_code
        ON tax.tax_risk_rule (jurisdiction_code, tax_type_code, rule_code)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_risk_rule
        ADD CONSTRAINT risk_rule_weight_sane
        CHECK (weight > 0 AND weight <= 100)
    `);

    /** The scores a selection run produced, kept so a selection can be explained. */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_selection_candidate' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        selection_run_id: { type: BIGINT, allowNull: false },
        taxpayer_id: { type: BIGINT, allowNull: false },
        tax_type_code: { type: STRING(20), allowNull: false },
        assessment_year: { type: STRING(9), allowNull: false },
        total_score: { type: INTEGER, allowNull: false },
        /** Which rules fired, and what each contributed. */
        matched_rules_json: { type: JSONB, allowNull: false, defaultValue: [] },
        selected: { type: BOOLEAN, allowNull: false, defaultValue: false },
        case_id: { type: BIGINT, allowNull: true },
        suppressed_reason: { type: TEXT, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_selection_candidate' },
      ['selection_run_id'],
      { name: 'ix_selection_candidate_run' },
    );

    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_risk_rule
        (jurisdiction_code, tax_type_code, rule_code, display_key, indicator_code,
         parameters_json, weight, is_mandatory_referral, effective_from,
         created_at, updated_at, is_active)
      VALUES
        ('GB', 'CIT', 'NON_FILER',        'ta.risk.nonFiler',       'NO_RETURN_FILED',      '{}'::jsonb,                         40, true,  '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'LARGE_LOSS',       'ta.risk.largeLoss',      'LOSS_ABOVE',           '{"threshold": "100000"}'::jsonb,     25, false, '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'CREDIT_HEAVY',     'ta.risk.creditHeavy',    'CREDIT_RATIO_ABOVE',   '{"ratio": "0.5"}'::jsonb,           20, false, '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'PRIOR_ADJUSTMENT', 'ta.risk.priorAdjustment','PRIOR_ADJUSTMENT_ABOVE','{"threshold": "10000"}'::jsonb,     30, false, '2023-04-01', now(), now(), true),
        ('SA', 'CIT', 'NON_FILER',        'ta.risk.nonFiler',       'NO_RETURN_FILED',      '{}'::jsonb,                         40, true,  '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'PRIOR_ADJUSTMENT', 'ta.risk.priorAdjustment','PRIOR_ADJUSTMENT_ABOVE','{"threshold": "50000"}'::jsonb,     30, false, '2024-01-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // ---------------------------------------------------- objection deposit

    /**
     * When an objection requires a deposit, and how much.
     *
     * Several jurisdictions require part of the disputed tax to be deposited
     * before an objection is heard. Where a jurisdiction has no row, no
     * deposit is required, which is the correct default: inventing one would
     * be a barrier to a statutory right.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_objection_deposit_rule' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: STRING(3), allowNull: false },
        tax_type_code: { type: STRING(20), allowNull: true },
        /** Fraction of the disputed amount, as an exact decimal string. */
        percent_of_disputed: { type: DECIMAL(10, 6), allowNull: false },
        minimum_amount: { type: DECIMAL(20, 4), allowNull: true },
        maximum_amount: { type: DECIMAL(20, 4), allowNull: true },
        /** Whether collection is stayed once the deposit is paid. */
        stays_collection: { type: BOOLEAN, allowNull: false, defaultValue: true },
        effective_from: { type: DATEONLY, allowNull: true },
        effective_to: { type: DATEONLY, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_deposit_rule_scope
        ON tax.tax_objection_deposit_rule (jurisdiction_code, COALESCE(tax_type_code, '*'))
        WHERE is_active
    `);

    // Saudi Arabia requires a deposit; the United Kingdom does not. That
    // difference is the point: both are representable without code.
    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_objection_deposit_rule
        (jurisdiction_code, tax_type_code, percent_of_disputed, minimum_amount, maximum_amount,
         stays_collection, effective_from, created_at, updated_at, is_active)
      VALUES ('SA', 'CIT', 0.100000, 1000.0000, 500000.0000, true, '2024-01-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // -------------------------------------------------------- permissions

    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('GET /api/v1/cases/:id/sla',                 1, 10, 'SLA clocks on a case', now(), now(), true),
        ('GET /api/v1/selection/runs',                1, 10, 'Risk selection runs', now(), now(), true),
        ('GET /api/v1/selection/runs/:id',            1, 10, 'Candidates from a selection run', now(), now(), true),
        ('POST /api/v1/selection/runs',               1, 30, 'Run risk-based selection', now(), now(), true),
        ('POST /api/v1/selection/runs/:id/open-cases',1, 30, 'Open cases from a selection run', now(), now(), true),
        ('GET /api/v1/risk-rules',                    1, 10, 'Risk rules in force', now(), now(), true),
        ('POST /api/v1/objections/:uuid/deposit',     1, 20, 'Record an objection deposit', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('GET /api/v1/cases/:id/sla',
                                  'GET /api/v1/selection/runs',
                                  'GET /api/v1/selection/runs/:id',
                                  'GET /api/v1/risk-rules')
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);

    // Selection decides who gets assessed. That is a policy act, not casework.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 30, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/selection/runs',
                                  'POST /api/v1/selection/runs/:id/open-cases')
       WHERE r.role_code IN ('TA_SUPERVISOR', 'TA_ADMIN')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'POST /api/v1/objections/:uuid/deposit'
       WHERE r.role_code IN ('TA_OBJECTION_OFFICER', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (SELECT id FROM platform.permission
                                WHERE permission_key LIKE '%selection%'
                                   OR permission_key LIKE '%risk-rules'
                                   OR permission_key LIKE '%/deposit'
                                   OR permission_key LIKE '%/sla')
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM platform.permission
       WHERE permission_key LIKE '%selection%'
          OR permission_key LIKE '%risk-rules'
          OR permission_key LIKE '%/deposit'
          OR permission_key LIKE '%/sla'
    `);
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_objection_deposit_rule' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_selection_candidate' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_risk_rule' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_sla_config' });
  },
};
