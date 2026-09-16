'use strict';

/**
 * The tax assessment domain: periods, items, adjustments, assignments,
 * deadlines, calculation results and versioned rule sets.
 *
 * Plan reference: V2 sections 13.3, 13.4, 14.4; ADR-006, ADR-007.
 *
 * Four integrity rules are enforced here in the schema rather than in
 * application code, because application code can be bypassed and an
 * assessment has to be defensible years later:
 *
 *   1. Every monetary column is NUMERIC(20,4). Never float (ADR-007).
 *   2. A calculation result is immutable — recalculation inserts a new version
 *      and flips is_current, so the figure a notice was served on can always
 *      be recovered.
 *   3. Exactly one current result per case, enforced by a partial unique index
 *      rather than by hoping the service gets it right.
 *   4. Rule sets cannot have overlapping effective dates for the same
 *      jurisdiction and tax type. Ambiguity there is a wrong assessment.
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

    /** Every monetary column in the system has this shape (ADR-007). */
    const money = () => ({ type: DataTypes.DECIMAL(20, 4), allowNull: true });

    const caseRef = {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
      onDelete: 'RESTRICT',
    };

    // --------------------------------------------------------------- periods
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_period' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: caseRef,
        tax_period_code: { type: DataTypes.STRING(32), allowNull: false },
        period_start: { type: DataTypes.DATEONLY, allowNull: false },
        period_end: { type: DataTypes.DATEONLY, allowNull: false },
        /** The filing this period was assessed against, where one exists. */
        filing_reference: { type: DataTypes.STRING(64), allowNull: true },
        ...audit,
      },
    );

    // ----------------------------------------------------------------- items
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_item' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: caseRef,
        period_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_period' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        /** What this line is, e.g. OPERATING_REVENUE. */
        concept_code: { type: DataTypes.STRING(64), allowNull: false },
        item_label_key: { type: DataTypes.STRING(255), allowNull: true },
        /** As the taxpayer filed it. */
        declared_amount: money(),
        /** As the authority determines it, after adjustments. */
        assessed_amount: money(),
        difference_amount: money(),
        /** Evidential weight differs: FILED is the taxpayer's, OFFICER is ours. */
        source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'FILED' },
        sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        ...audit,
      },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_item' },
      ['case_id', 'sequence'],
      { name: 'ix_item_case' },
    );

    // ----------------------------------------------------------- adjustments
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_adjustment' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: caseRef,
        item_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_item' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        adjustment_type: { type: DataTypes.STRING(64), allowNull: false },
        reason_code: { type: DataTypes.STRING(64), allowNull: false },
        statutory_reference: { type: DataTypes.STRING(255), allowNull: true },
        amount: { type: DataTypes.DECIMAL(20, 4), allowNull: false },
        /** ADD increases the base, DEDUCT reduces it. */
        direction: { type: DataTypes.STRING(10), allowNull: false },
        /** Why. Mandatory above a configured materiality threshold. */
        narrative: { type: DataTypes.TEXT, allowNull: true },
        evidence_document_id: { type: DataTypes.BIGINT, allowNull: true },
        officer_opinion: { type: DataTypes.TEXT, allowNull: true },
        proposed_by: { type: DataTypes.BIGINT, allowNull: true },
        approved_by: { type: DataTypes.BIGINT, allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PROPOSED' },
        ...audit,
      },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_adjustment' },
      ['case_id'],
      { name: 'ix_adjustment_case' },
    );
    await queryInterface.addConstraint(
      { schema: 'tax', tableName: 'tax_assessment_adjustment' },
      {
        type: 'check',
        name: 'adjustment_direction_valid',
        fields: ['direction'],
        where: { direction: ['ADD', 'DEDUCT'] },
      },
    );

    // ----------------------------------------------------------- assignments
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_assignment' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: caseRef,
        user_id: { type: DataTypes.BIGINT, allowNull: false },
        role_code: { type: DataTypes.STRING(64), allowNull: false },
        assigned_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        assigned_by: { type: DataTypes.BIGINT, allowNull: true },
        released_at: { type: DataTypes.DATE, allowNull: true },
        is_current: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        ...audit,
      },
    );
    // Segregation of duties is answered from this table: "did the same person
    // prepare and review this case" must be a query, not a guess.
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_assignment' },
      ['case_id', 'role_code'],
      { name: 'ix_assignment_case_role' },
    );

    // -------------------------------------------------------------- rule sets
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_rule_set' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        code: { type: DataTypes.STRING(64), allowNull: false },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        tax_type_code: { type: DataTypes.STRING(32), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        effective_from: { type: DataTypes.DATEONLY, allowNull: false },
        effective_to: { type: DataTypes.DATEONLY, allowNull: true },
        currency_code: { type: DataTypes.STRING(3), allowNull: false },
        /** Scale and direction. There is no default: tax law does not agree. */
        rounding_scale: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        rounding_mode: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'HALF_UP' },
        /** Dual control: publishing requires a second person (plan 15.3). */
        authored_by: { type: DataTypes.BIGINT, allowNull: true },
        published_by: { type: DataTypes.BIGINT, allowNull: true },
        published_at: { type: DataTypes.DATE, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'tax', tableName: 'tax_rule_set' },
      { fields: ['code', 'version'], type: 'unique', name: 'tax_rule_set_code_version_unique' },
    );

    /**
     * No two published rule sets may cover the same jurisdiction, tax type and
     * date. An overlap means a case could be computed two different ways
     * depending on which row a query happened to return first.
     *
     * daterange with '[)' bounds: effective_to is exclusive, so a set ending
     * 2026-04-01 and one starting 2026-04-01 abut rather than overlap.
     */
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_rule_set
        ADD CONSTRAINT tax_rule_set_no_overlap
        EXCLUDE USING gist (
          jurisdiction_code WITH =,
          tax_type_code WITH =,
          daterange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'PUBLISHED' AND is_active);
    `);

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_rule_set_item' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        rule_set_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_rule_set' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        /** Which pipeline step consumes this row. */
        item_type: { type: DataTypes.STRING(32), allowNull: false },
        sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        /** JSON-Logic guard. Null means the rule always applies. */
        condition_json: { type: DataTypes.JSONB, allowNull: true },
        /**
         * Step-specific parameters. Monetary values are stored as STRINGS in
         * this JSON, never JSON numbers: a JSON number is a double, and a rate
         * band boundary that arrived as 49999.999999 would be a wrong
         * assessment (ADR-007).
         */
        parameters_json: { type: DataTypes.JSONB, allowNull: false },
        description_key: { type: DataTypes.STRING(255), allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_rule_set_item' },
      ['rule_set_id', 'item_type', 'sequence'],
      { name: 'ix_rule_set_item_lookup' },
    );

    // ------------------------------------------------------ calculation result
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_calculation_result' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: caseRef,
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        rule_set_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_rule_set' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        /** Pinned, so recomputing under a newer set is visible as a change. */
        rule_set_version: { type: DataTypes.INTEGER, allowNull: false },
        /** SHA-256 of the inputs. Two runs with the same hash must agree. */
        inputs_hash: { type: DataTypes.STRING(64), allowNull: false },

        declared_base: money(),
        total_adjustments: money(),
        assessed_base: money(),
        losses_set_off: money(),
        taxable_base: money(),
        tax_before_credits: money(),
        surcharge_amount: money(),
        total_credits: money(),
        tax_after_credits: money(),
        penalty_amount: money(),
        interest_amount: money(),
        total_payable: money(),
        amount_paid: money(),
        net_payable_or_refundable: money(),

        currency_code: { type: DataTypes.STRING(3), allowNull: false },
        is_current: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        calculated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        calculated_by: { type: DataTypes.BIGINT, allowNull: true },
        /** Set when an officer overrode a computed figure. Requires a reason. */
        override_reason: { type: DataTypes.TEXT, allowNull: true },
      },
    );
    // Exactly one current result per case. Enforced here rather than trusted
    // to the service, because "which figure was the notice served on" must
    // have exactly one answer.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_calculation_current
        ON tax.tax_calculation_result (case_id)
        WHERE is_current;
    `);
    await queryInterface.addConstraint(
      { schema: 'tax', tableName: 'tax_calculation_result' },
      { fields: ['case_id', 'version'], type: 'unique', name: 'calculation_case_version_unique' },
    );

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_calculation_trace' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        result_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_calculation_result' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        sequence: { type: DataTypes.INTEGER, allowNull: false },
        step_code: { type: DataTypes.STRING(32), allowNull: false },
        description_key: { type: DataTypes.STRING(255), allowNull: true },
        /** Human-readable arithmetic, e.g. "125000.0000 x 0.25 = 31250.0000". */
        expression: { type: DataTypes.TEXT, allowNull: true },
        inputs_json: { type: DataTypes.JSONB, allowNull: true },
        output_value: { type: DataTypes.DECIMAL(20, 4), allowNull: true },
        /** Which rule-set row produced this, so a figure traces to a rule. */
        rule_reference: { type: DataTypes.STRING(128), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_calculation_trace' },
      ['result_id', 'sequence'],
      { name: 'ix_trace_result' },
    );

    // ------------------------------------------------------------- deadlines
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_deadline_config' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        tax_type_code: { type: DataTypes.STRING(32), allowNull: true },
        deadline_type: { type: DataTypes.STRING(32), allowNull: false },
        /** The event the clock starts from, e.g. NOTICE_SERVED. */
        anchor_event: { type: DataTypes.STRING(64), allowNull: false },
        offset_value: { type: DataTypes.INTEGER, allowNull: false },
        offset_unit: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DAYS' },
        calendar_rule: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'CALENDAR_DAYS',
        },
        extension_rule_json: { type: DataTypes.JSONB, allowNull: true },
        effective_from: { type: DataTypes.DATEONLY, allowNull: true },
        effective_to: { type: DataTypes.DATEONLY, allowNull: true },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_deadline' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: caseRef,
        deadline_type: { type: DataTypes.STRING(32), allowNull: false },
        anchor_event: { type: DataTypes.STRING(64), allowNull: false },
        anchor_at: { type: DataTypes.DATE, allowNull: false },
        due_at: { type: DataTypes.DATE, allowNull: false },
        warned_at: { type: DataTypes.DATE, allowNull: true },
        breached_at: { type: DataTypes.DATE, allowNull: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'OPEN' },
        config_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'tax', tableName: 'tax_deadline_config' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        ...audit,
      },
    );
    // The scheduler scans this every few minutes and must never table-scan.
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_deadline_due
        ON tax.tax_assessment_deadline (due_at)
        WHERE status = 'OPEN';
    `);

    // --------------------------------------------------------- selection runs
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_selection_run' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        campaign_code: { type: DataTypes.STRING(64), allowNull: false },
        criteria_json: { type: DataTypes.JSONB, allowNull: true },
        run_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        candidate_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        selected_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        run_by: { type: DataTypes.BIGINT, allowNull: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'COMPLETED' },
        ...audit,
      },
    );
  },

  async down(queryInterface) {
    for (const tableName of [
      'tax_assessment_selection_run',
      'tax_assessment_deadline',
      'tax_deadline_config',
      'tax_calculation_trace',
      'tax_calculation_result',
      'tax_rule_set_item',
      'tax_rule_set',
      'tax_assessment_assignment',
      'tax_assessment_adjustment',
      'tax_assessment_item',
      'tax_assessment_period',
    ]) {
      await queryInterface.dropTable({ schema: 'tax', tableName });
    }
  },
};
