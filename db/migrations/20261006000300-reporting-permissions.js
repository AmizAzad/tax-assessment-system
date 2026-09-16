'use strict';

/**
 * Reporting routes.
 *
 * Plan reference: V2 sections 6.3, 21.1.
 *
 * ## Why reports are not granted to caseworkers
 *
 * A report answers questions about the whole register, so it cannot be scoped
 * to the caller's own cases without every total being wrong. That makes each
 * of these routes a disclosure of the complete assessment position, which is
 * management information rather than casework.
 *
 * The reconciliation report is FULL and administrator-only for a different
 * reason: every row it returns is a defect in the register, and that list is
 * a map of where the data is currently wrong.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('GET /api/v1/reports/assessment-summary',  1, 10, 'Cases and net assessed by status', now(), now(), true),
        ('GET /api/v1/reports/collection',          1, 10, 'Assessed against collected', now(), now(), true),
        ('GET /api/v1/reports/adjustment-analysis', 1, 10, 'Adjustment reasons by value', now(), now(), true),
        ('GET /api/v1/reports/dispute-outcomes',    1, 10, 'Objection and appeal outcomes', now(), now(), true),
        ('GET /api/v1/reports/ageing',              1, 10, 'Where cases are stuck', now(), now(), true),
        ('GET /api/v1/reports/deadline-exposure',   1, 10, 'Statutory clocks at risk', now(), now(), true),
        ('GET /api/v1/reports/unserved-notices',    1, 10, 'Notices never successfully served', now(), now(), true),
        ('GET /api/v1/reports/reconciliation',      1, 30, 'Places where the register contradicts itself', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key LIKE 'GET /api/v1/reports/%'
         AND p.permission_key <> 'GET /api/v1/reports/reconciliation'
       WHERE r.role_code IN ('TA_SUPERVISOR', 'TA_ADMIN', 'TA_AUDITOR_READONLY')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 30, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'GET /api/v1/reports/reconciliation'
       WHERE r.role_code IN ('TA_ADMIN', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    /**
     * Indexes the reports depend on.
     *
     * The register is expected to reach millions of rows. Each of these backs
     * a `GROUP BY` or filter that would otherwise be a sequential scan, and
     * adding them now is cheaper than discovering them in a load test.
     */
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS ix_case_reporting
        ON tax.tax_assessment_case (jurisdiction_code, tax_type_code, assessment_year, status_code)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS ix_case_opened_at
        ON tax.tax_assessment_case (opened_at)
        WHERE is_active
    `);

    // Ageing scans by last movement; without this it sorts the whole register.
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS ix_case_updated_open
        ON tax.tax_assessment_case (updated_at)
        WHERE is_active AND status_code NOT IN ('CLOSED', 'CANCELLED', 'SETTLED', 'WRITTEN_OFF')
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS ix_adjustment_reason
        ON tax.tax_assessment_adjustment (adjustment_type, reason_code)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS ix_account_entry_period_type
        ON tax.taxpayer_account_entry (tax_type_code, assessment_year, entry_type)
        WHERE is_active
    `);
  },

  async down(queryInterface) {
    for (const index of [
      'ix_case_reporting',
      'ix_case_opened_at',
      'ix_case_updated_open',
      'ix_adjustment_reason',
      'ix_account_entry_period_type',
    ]) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS tax.${index}`);
    }
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (SELECT id FROM platform.permission
                                WHERE permission_key LIKE 'GET /api/v1/reports/%')
    `);
    await queryInterface.sequelize.query(
      `DELETE FROM platform.permission WHERE permission_key LIKE 'GET /api/v1/reports/%'`,
    );
  },
};
