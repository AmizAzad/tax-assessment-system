'use strict';

/**
 * The taxpayer account: what has been paid, what credits are held, what losses
 * are carried forward.
 *
 * Plan reference: V2 sections 8.2, 9.4.
 *
 * ## Why these are not case tables
 *
 * A payment belongs to the taxpayer and a period, not to an assessment case.
 * Two cases may be opened against the same period over its life (an original
 * desk assessment, then a later audit), and both must see the same payment
 * history. Hanging payments off the case would either duplicate them or make
 * the second case blind to the first.
 *
 * ## Why losses are a memorandum table rather than a derived figure
 *
 * A loss carried forward is the result of a finalised assessment for an
 * earlier year, possibly amended on appeal years later. Recomputing the chain
 * on demand would mean every current assessment silently depends on the
 * mutable history of every prior one. Instead each finalised assessment writes
 * what it leaves behind, and `consumed_amount` records what later years took.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { INTEGER, BIGINT, STRING, DECIMAL, DATE, DATEONLY, BOOLEAN, TEXT } = Sequelize;

    // Exact decimals throughout: NUMERIC(20,4), never a float (ADR-007).
    const money = { type: DECIMAL(20, 4), allowNull: false };

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'taxpayer_account_entry' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: Sequelize.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        taxpayer_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'taxpayer' }, key: 'id' },
        },
        tax_type_code: { type: STRING(20), allowNull: false },
        assessment_year: { type: STRING(9), allowNull: false },

        /**
         * PAYMENT settles a liability. WITHHOLDING_CREDIT and
         * FOREIGN_TAX_CREDIT reduce the tax before it is settled. They are
         * kept in one table because they share provenance and period
         * attribution, and separated by this column because the calculation
         * treats them at different steps.
         */
        entry_type: { type: STRING(30), allowNull: false },
        credit_code: { type: STRING(40), allowNull: true },

        amount: money,
        currency_code: { type: STRING(3), allowNull: false },

        /**
         * A credit that can reduce liability to nil but never create a
         * repayment. Getting this wrong pays money out that is not owed, so it
         * is explicit rather than inferred from the credit code.
         */
        is_non_refundable: { type: BOOLEAN, allowNull: false, defaultValue: false },

        value_date: { type: DATEONLY, allowNull: false },
        source_system: { type: STRING(40), allowNull: false },
        source_reference: { type: STRING(100), allowNull: true },
        narrative: { type: TEXT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'taxpayer_account_entry' },
      ['taxpayer_id', 'tax_type_code', 'assessment_year'],
      { name: 'ix_account_entry_period' },
    );

    // The same payment arriving twice from the same source is a reconciliation
    // failure that would otherwise silently reduce an assessment.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_account_entry_source
        ON tax.taxpayer_account_entry (source_system, source_reference)
        WHERE source_reference IS NOT NULL AND is_active
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.taxpayer_account_entry
        ADD CONSTRAINT account_entry_type_valid
        CHECK (entry_type IN ('PAYMENT', 'WITHHOLDING_CREDIT', 'FOREIGN_TAX_CREDIT', 'ADVANCE_PAYMENT'))
    `);

    // A credit without a code cannot be traced to the rule that allows it.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.taxpayer_account_entry
        ADD CONSTRAINT account_entry_credit_code_present
        CHECK (entry_type = 'PAYMENT' OR entry_type = 'ADVANCE_PAYMENT' OR credit_code IS NOT NULL)
    `);

    // A negative payment is a refund and belongs in its own entry with its own
    // provenance, not as a sign flip on an existing row.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.taxpayer_account_entry
        ADD CONSTRAINT account_entry_amount_positive CHECK (amount > 0)
    `);

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'taxpayer_loss' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: Sequelize.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        taxpayer_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'taxpayer' }, key: 'id' },
        },
        tax_type_code: { type: STRING(20), allowNull: false },

        /** The year the loss arose. Drives the oldest-first set-off order. */
        origin_year: { type: STRING(9), allowNull: false },
        loss_type: { type: STRING(30), allowNull: false, defaultValue: 'TRADING' },

        original_amount: money,
        consumed_amount: { type: DECIMAL(20, 4), allowNull: false, defaultValue: '0' },
        currency_code: { type: STRING(3), allowNull: false },

        /**
         * Some jurisdictions time-limit carry-forward. Null means indefinite,
         * which is the UK position for post-2017 trading losses.
         */
        expires_after_year: { type: STRING(9), allowNull: true },

        /** The finalised case that established this loss, where there was one. */
        established_by_case_id: { type: BIGINT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'taxpayer_loss' },
      ['taxpayer_id', 'tax_type_code', 'origin_year'],
      { name: 'ix_loss_taxpayer_period' },
    );

    // Consuming more loss than arose would relieve tax that was never lost.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.taxpayer_loss
        ADD CONSTRAINT loss_consumed_within_original
        CHECK (consumed_amount >= 0 AND consumed_amount <= original_amount)
    `);

    /**
     * Which losses a given case actually used.
     *
     * Without this, `consumed_amount` is a number nobody can explain. A
     * reviewer asking "why is only 12,000 of the 2022 loss left" needs the
     * list of cases that took the rest.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_loss_utilisation' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        loss_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'taxpayer_loss' }, key: 'id' },
        },
        case_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
        },
        calculation_result_id: { type: BIGINT, allowNull: true },
        amount_used: money,
        currency_code: { type: STRING(3), allowNull: false },
        sequence: { type: INTEGER, allowNull: false, defaultValue: 1 },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_loss_utilisation' },
      ['case_id'],
      { name: 'ix_loss_utilisation_case' },
    );

    // Permissions for the new surface.
    //
    // The catalogue is route-keyed: an unregistered route is refused, so every
    // route added here must appear or it fails closed (plan 6.3).
    // Levels: 10 VIEW, 20 EDIT, 30 FULL.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('GET /api/v1/cases/:id/evidence',          1, 10, 'Read the evidence snapshot', now(), now(), true),
        ('POST /api/v1/cases/:id/evidence/refresh', 1, 20, 'Re-run the evidence fan-out', now(), now(), true),
        ('GET /api/v1/taxpayers/:taxpayerId/account', 1, 10, 'Read payments, credits and losses', now(), now(), true),
        ('POST /api/v1/taxpayers/:taxpayerId/account', 1, 30, 'Record a payment or credit', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    /**
     * Grants.
     *
     * Reading evidence is open to every internal role, because a reviewer who
     * cannot see the source data cannot review the assessment. Refreshing it
     * is limited to the roles that prepare a case. Writing to the account is
     * FULL and supervisor-only: an invented payment reduces an assessment.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('GET /api/v1/cases/:id/evidence',
                                  'GET /api/v1/taxpayers/:taxpayerId/account')
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key = 'POST /api/v1/cases/:id/evidence/refresh'
       WHERE r.role_code IN ('TA_ASSESSOR', 'TA_SPECIALIST', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 30, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key = 'POST /api/v1/taxpayers/:taxpayerId/account'
       WHERE r.role_code = 'TA_SUPERVISOR'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (
         SELECT id FROM platform.permission
          WHERE permission_key IN ('GET /api/v1/cases/:id/evidence',
                                   'POST /api/v1/cases/:id/evidence/refresh',
                                   'GET /api/v1/taxpayers/:taxpayerId/account',
                                   'POST /api/v1/taxpayers/:taxpayerId/account'))
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM platform.permission
       WHERE permission_key IN ('GET /api/v1/cases/:id/evidence',
                                'POST /api/v1/cases/:id/evidence/refresh',
                                'GET /api/v1/taxpayers/:taxpayerId/account',
                                'POST /api/v1/taxpayers/:taxpayerId/account')
    `);
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_loss_utilisation' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'taxpayer_loss' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'taxpayer_account_entry' });
  },
};
