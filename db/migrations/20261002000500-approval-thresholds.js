'use strict';

/**
 * Which approval level a case needs, by how much money is at stake.
 *
 * Plan reference: V2 sections 11.2, 11.3.
 *
 * ## Why this is a table
 *
 * "Assessments over a million need a level three approver" is a policy that
 * changes without the law changing, and it differs per jurisdiction and per
 * tax type. Compiled into code it becomes a deployment every time a finance
 * ministry revises a delegation limit.
 *
 * ## Why bands rather than a single ceiling per role
 *
 * A band has both ends, so the configuration itself says what happens to an
 * amount between two limits. A list of ceilings leaves the gaps implicit and
 * the ordering significant, which is how an assessment ends up routed to
 * nobody.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { BIGINT, STRING, DECIMAL, DATE, DATEONLY, BOOLEAN } = Sequelize;

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_approval_threshold' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: STRING(3), allowNull: false },
        tax_type_code: { type: STRING(20), allowNull: false },

        /**
         * Inclusive lower bound, exclusive upper bound. Null upper means
         * unbounded, so the top band always catches whatever arrives and no
         * assessment can fall through unrouted.
         */
        amount_from: { type: DECIMAL(20, 4), allowNull: false, defaultValue: '0' },
        amount_to: { type: DECIMAL(20, 4), allowNull: true },
        currency_code: { type: STRING(3), allowNull: false },

        required_role_code: { type: STRING(40), allowNull: false },

        /**
         * How many distinct approvals the band needs.
         *
         * Above a certain figure a single signature is not enough in most
         * revenue authorities, and that is a different question from which
         * role signs.
         */
        required_approvals: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },

        effective_from: { type: DATEONLY, allowNull: true },
        effective_to: { type: DATEONLY, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    // Two bands covering the same amount would route the same case to two
    // different roles depending on row order. The exclusion constraint makes
    // that unrepresentable rather than merely unlikely.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_approval_threshold
        ADD CONSTRAINT tax_approval_threshold_no_overlap
        EXCLUDE USING gist (
          jurisdiction_code WITH =,
          tax_type_code WITH =,
          numrange(amount_from, amount_to, '[)') WITH &&
        )
        WHERE (is_active)
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_approval_threshold
        ADD CONSTRAINT tax_approval_threshold_band_ordered
        CHECK (amount_to IS NULL OR amount_to > amount_from)
    `);

    /**
     * UK corporation tax delegation limits.
     *
     * Illustrative rather than sourced from an HMRC delegation schedule, which
     * is internal. They are configuration: an authority adopting this platform
     * replaces the rows without touching code. The shape is what matters here,
     * and the top band deliberately has no ceiling.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_approval_threshold
        (jurisdiction_code, tax_type_code, amount_from, amount_to, currency_code,
         required_role_code, required_approvals, created_at, updated_at, is_active)
      VALUES
        ('GB', 'CIT',       0.0000,   100000.0000, 'GBP', 'TA_APPROVER_L1', 1, now(), now(), true),
        ('GB', 'CIT',  100000.0000,  1000000.0000, 'GBP', 'TA_APPROVER_L2', 1, now(), now(), true),
        ('GB', 'CIT', 1000000.0000,          NULL, 'GBP', 'TA_APPROVER_L3', 2, now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('POST /api/v1/cases/:id/route-approval', 1, 20, 'Route a reviewed case to the right approver', now(), now(), true),
        ('POST /api/v1/cases/:id/finalise',       1, 20, 'Finalise an approved assessment', now(), now(), true),
        ('GET /api/v1/cases/:id/deadlines',       1, 10, 'Statutory dates for a case', now(), now(), true),
        ('GET /api/v1/approval-thresholds',       1, 10, 'Approval delegation limits', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    /**
     * Grants.
     *
     * Routing and finalising are SYSTEM transitions in the state machine, so
     * these permissions govern who may ask the platform to perform them, not
     * who is recorded as having decided. A reviewer asks for routing; an
     * approver asks for finalisation once approval is recorded.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key = 'POST /api/v1/cases/:id/route-approval'
       WHERE r.role_code IN ('TA_REVIEWER', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key = 'POST /api/v1/cases/:id/finalise'
       WHERE r.role_code IN ('TA_APPROVER_L1', 'TA_APPROVER_L2', 'TA_APPROVER_L3', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('GET /api/v1/cases/:id/deadlines',
                                  'GET /api/v1/approval-thresholds')
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (
         SELECT id FROM platform.permission
          WHERE permission_key IN ('POST /api/v1/cases/:id/route-approval',
                                   'POST /api/v1/cases/:id/finalise',
                                   'GET /api/v1/cases/:id/deadlines',
                                   'GET /api/v1/approval-thresholds'))
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM platform.permission
       WHERE permission_key IN ('POST /api/v1/cases/:id/route-approval',
                                'POST /api/v1/cases/:id/finalise',
                                'GET /api/v1/cases/:id/deadlines',
                                'GET /api/v1/approval-thresholds')
    `);
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_approval_threshold' });
  },
};
