'use strict';

/**
 * Tax assessment case core, the domain event ledger and evidence snapshots.
 *
 * Plan reference: V2 sections 13.3 and 13.4.
 *
 * Three integrity rules are enforced here in the schema rather than in
 * application code, because application code can be bypassed and a tax
 * assessment has to be defensible years later:
 *
 *   1. Money is NUMERIC(20,4). Never float, never double (ADR-007).
 *   2. tax_assessment_event and tax_assessment_evidence are append-only.
 *      UPDATE and DELETE are revoked from the application role in a later
 *      migration once that role exists.
 *   3. Foreign keys are ON DELETE RESTRICT throughout. Assessments are never
 *      hard-deleted; is_active is the only delete.
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

    /** Every monetary column in the system has this shape. */
    const money = { type: DataTypes.DECIMAL(20, 4), allowNull: true };

    // ------------------------------------------------------------- taxpayer
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'taxpayer' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        tin: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        name: { type: 'CITEXT', allowNull: false },
        // LEGAL for companies, NATURAL for individuals. PIT support needs the
        // latter; whether it is in v1 is open question Q2.
        taxpayer_kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'LEGAL' },
        taxpayer_type_code: { type: DataTypes.STRING(64), allowNull: true },
        sector_code: { type: DataTypes.STRING(64), allowNull: true },
        registration_date: { type: DataTypes.DATEONLY, allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ACTIVE' },
        financial_year_end: { type: DataTypes.STRING(8), allowNull: true },
        preferred_language: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en' },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        ...audit,
      },
    );

    // ----------------------------------------------------------------- case
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_case' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        case_number: { type: DataTypes.STRING(64), allowNull: false, unique: true },

        taxpayer_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'taxpayer' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        // Denormalised deliberately: the register must remain readable and the
        // case must remain defensible even if the taxpayer record is later
        // corrected. These are the values as they stood when the case opened.
        tin: { type: DataTypes.STRING(64), allowNull: false },
        taxpayer_name: { type: DataTypes.STRING(512), allowNull: false },

        tax_type_code: { type: DataTypes.STRING(32), allowNull: false },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        assessment_year: { type: DataTypes.STRING(16), allowNull: false },
        assessment_type: { type: DataTypes.STRING(32), allowNull: false },
        trigger_path: { type: DataTypes.STRING(32), allowNull: false },

        selection_run_id: { type: DataTypes.BIGINT, allowNull: true },
        risk_score: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
        risk_model_version: { type: DataTypes.STRING(32), allowNull: true },

        status_code: { type: DataTypes.STRING(48), allowNull: false },
        // The liability axis is separate from case status and must never be
        // conflated with it: a case can be CLOSED while liability is
        // PARTLY_PAID (plan section 16.2 rule 5).
        liability_status: {
          type: DataTypes.STRING(32),
          allowNull: false,
          defaultValue: 'UNPAID',
        },

        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        predecessor_case_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
          onDelete: 'RESTRICT',
        },

        // Flowable correlation. business_key is always the case number so that
        // objection and appeal processes correlate to their parent.
        process_instance_id: { type: DataTypes.STRING(64), allowNull: true },
        business_key: { type: DataTypes.STRING(64), allowNull: true },
        process_definition_version: { type: DataTypes.STRING(64), allowNull: true },

        currency_code: { type: DataTypes.STRING(3), allowNull: false },
        assessed_base: money,
        net_payable: money,

        limitation_date: { type: DataTypes.DATEONLY, allowNull: true },
        target_completion_date: { type: DataTypes.DATEONLY, allowNull: true },
        opened_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        finalised_at: { type: DataTypes.DATE, allowNull: true },
        closed_at: { type: DataTypes.DATE, allowNull: true },
        closure_reason: { type: DataTypes.STRING(64), allowNull: true },
        // Blocks retention-driven deletion regardless of retention class.
        legal_hold: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ...audit,
      },
    );

    // One open case per taxpayer, tax type, year and version. Partial, so
    // cancelled cases do not block a legitimate retry.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_case_scope_version
        ON tax.tax_assessment_case (taxpayer_id, tax_type_code, assessment_year, version)
        WHERE status_code <> 'CANCELLED';
    `);

    // ----------------------------------------------------------- event ledger
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_event' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        event_type: { type: DataTypes.STRING(64), allowNull: false },
        from_status: { type: DataTypes.STRING(48), allowNull: true },
        to_status: { type: DataTypes.STRING(48), allowNull: true },
        actor_user_id: { type: DataTypes.BIGINT, allowNull: true },
        actor_role_code: { type: DataTypes.STRING(64), allowNull: true },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        payload_json: { type: DataTypes.JSONB, allowNull: true },
        correlation_id: { type: DataTypes.STRING(64), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        created_by: { type: DataTypes.BIGINT, allowNull: true },
      },
    );

    // ------------------------------------------------------------- evidence
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_evidence' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        case_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        source_system: { type: DataTypes.STRING(64), allowNull: false },
        request_json: { type: DataTypes.JSONB, allowNull: true },
        response_json: { type: DataTypes.JSONB, allowNull: true },
        // Large payloads go to object storage; only the reference is held here.
        document_id: { type: DataTypes.BIGINT, allowNull: true },
        // SHA-256 of the payload as retrieved. This is what makes the snapshot
        // tamper-evident and the assessment reproducible.
        payload_hash: { type: DataTypes.STRING(64), allowNull: false },
        retrieved_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        retrieved_by: { type: DataTypes.BIGINT, allowNull: true },
        is_current: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );

    // --------------------------------------------------------------- indexes
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_case' },
      ['status_code', 'tax_type_code', 'assessment_year'],
      { name: 'ix_case_register_filter' },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_case' },
      ['taxpayer_id'],
      { name: 'ix_case_taxpayer' },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_case' },
      ['process_instance_id'],
      { name: 'ix_case_process_instance' },
    );
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_event' },
      ['case_id', 'occurred_at'],
      { name: 'ix_event_case_time' },
    );
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_evidence_current
        ON tax.tax_assessment_evidence (case_id, source_system)
        WHERE is_current;
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_assessment_evidence' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_assessment_event' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_assessment_case' });
    await queryInterface.dropTable({ schema: 'platform', tableName: 'taxpayer' });
  },
};
