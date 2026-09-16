'use strict';

/**
 * Reassessment and closure.
 *
 * Plan reference: V2 sections 14.1 to 14.6 (Phase 7, stages 13-14).
 *
 * ## Two shapes of reassessment
 *
 * A reassessment that follows from a dispute outcome continues the **same
 * case**: the tribunal varied this assessment, and the revised figure is a new
 * version of it. The lineage is the calculation version chain.
 *
 * A reassessment on new information after a case has closed is a **new case**
 * pointing at its predecessor. The original assessment was a completed legal
 * act; it is not reopened, it is succeeded. Modelling both as the same thing
 * would either lose the first assessment or pretend the second is an
 * amendment of something already spent.
 *
 * `tax_reassessment` records which shape was used, on what grounds, and
 * whether the limitation period allowed it.
 *
 * ## Why closure is a record and not just a status
 *
 * `status_code = 'CLOSED'` says a case is over. It does not say why, who
 * decided, what the balance was, or when the file may be destroyed. Those are
 * the questions asked years later, usually by someone holding a complaint.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { BIGINT, INTEGER, STRING, DECIMAL, DATE, DATEONLY, BOOLEAN, TEXT, JSONB } = Sequelize;

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_reassessment' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: Sequelize.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },

        /** The case being worked. For a successor, the new one. */
        case_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
        },
        /** Set only where a new case succeeds a closed one. */
        predecessor_case_id: { type: BIGINT, allowNull: true },

        /** IN_PLACE continues the same case; SUCCESSOR opens a new one. */
        shape: { type: STRING(20), allowNull: false },
        trigger_source: { type: STRING(30), allowNull: false },
        /** The objection or appeal that caused it, where there was one. */
        source_objection_id: { type: BIGINT, allowNull: true },
        source_appeal_id: { type: BIGINT, allowNull: true },

        grounds: { type: TEXT, allowNull: false },

        /**
         * The limitation position at the moment the reassessment was opened.
         *
         * Stored rather than recomputed. Limitation periods can be extended by
         * statute, and a case opened lawfully under the old rule must not
         * start reporting itself as out of time because the rule later
         * changed.
         */
        limitation_date: { type: DATEONLY, allowNull: true },
        within_limitation: { type: BOOLEAN, allowNull: false },
        limitation_override_reason: { type: TEXT, allowNull: true },
        authorised_by: { type: BIGINT, allowNull: true },

        /** What changed, once the revised calculation exists. */
        previous_calculation_id: { type: BIGINT, allowNull: true },
        revised_calculation_id: { type: BIGINT, allowNull: true },
        delta_amount: { type: DECIMAL(20, 4), allowNull: true },
        currency_code: { type: STRING(3), allowNull: true },

        status: { type: STRING(20), allowNull: false, defaultValue: 'OPEN' },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex({ schema: 'tax', tableName: 'tax_reassessment' }, ['case_id'], {
      name: 'ix_reassessment_case',
    });
    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_reassessment' },
      ['predecessor_case_id'],
      { name: 'ix_reassessment_predecessor' },
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_reassessment
        ADD CONSTRAINT reassessment_shape_valid
        CHECK (shape IN ('IN_PLACE', 'SUCCESSOR'))
    `);

    // A successor without a predecessor is not a reassessment, it is an
    // ordinary new case that has been mislabelled.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_reassessment
        ADD CONSTRAINT reassessment_successor_has_predecessor
        CHECK (shape <> 'SUCCESSOR' OR predecessor_case_id IS NOT NULL)
    `);

    /**
     * Assessing outside the limitation period must be a deliberate,
     * attributable act.
     *
     * Some jurisdictions allow it where fraud or deliberate concealment is
     * alleged. Allowing it silently would let an ordinary case quietly reach
     * back further than the law permits.
     */
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_reassessment
        ADD CONSTRAINT reassessment_out_of_time_authorised
        CHECK (within_limitation
               OR (limitation_override_reason IS NOT NULL AND authorised_by IS NOT NULL))
    `);

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_case_closure' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        case_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
        },
        reason_code: { type: STRING(40), allowNull: false },
        narrative: { type: TEXT, allowNull: true },

        /** The position at closure, so the file does not depend on live tables. */
        final_assessed_amount: { type: DECIMAL(20, 4), allowNull: true },
        final_paid_amount: { type: DECIMAL(20, 4), allowNull: true },
        final_balance: { type: DECIMAL(20, 4), allowNull: true },
        currency_code: { type: STRING(3), allowNull: true },

        closed_by: { type: BIGINT, allowNull: true },
        closed_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        /** True where the scheduler closed it rather than a person. */
        auto_closed: { type: BOOLEAN, allowNull: false, defaultValue: false },

        /**
         * When the file may be destroyed, and whether it may be at all.
         *
         * A legal hold outranks the retention date: a case under litigation
         * must survive its own retention rule, and a scheduler that deleted it
         * would be destroying evidence.
         */
        retention_class: { type: STRING(40), allowNull: false, defaultValue: 'STATUTORY' },
        retain_until: { type: DATEONLY, allowNull: true },
        legal_hold: { type: BOOLEAN, allowNull: false, defaultValue: false },
        legal_hold_reason: { type: TEXT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_closure_per_case
        ON tax.tax_case_closure (case_id)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_case_closure
        ADD CONSTRAINT closure_legal_hold_explained
        CHECK (NOT legal_hold OR legal_hold_reason IS NOT NULL)
    `);

    /**
     * Successor lineage, denormalised onto the case for cheap traversal.
     *
     * The column was already added by the original assessment-domain
     * migration, so this only ensures the index that makes walking a chain
     * cheap. `IF NOT EXISTS` rather than `addIndex` because re-running a
     * migration against a partially applied database should be survivable.
     */
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS ix_case_predecessor
        ON tax.tax_assessment_case (predecessor_case_id)
        WHERE predecessor_case_id IS NOT NULL
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('POST /api/v1/cases/:id/reassess',        1, 20, 'Open a reassessment', now(), now(), true),
        ('GET /api/v1/cases/:id/reassessments',    1, 10, 'Reassessment history', now(), now(), true),
        ('GET /api/v1/cases/:id/lineage',          1, 10, 'Predecessor and successor chain', now(), now(), true),
        ('GET /api/v1/cases/:id/calculation/delta',1, 10, 'What changed between versions', now(), now(), true),
        ('POST /api/v1/cases/:id/close',           1, 20, 'Close a case', now(), now(), true),
        ('GET /api/v1/cases/:id/closure',          1, 10, 'The closure record', now(), now(), true),
        ('POST /api/v1/cases/:id/legal-hold',      1, 30, 'Place or lift a legal hold', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('GET /api/v1/cases/:id/reassessments',
                                  'GET /api/v1/cases/:id/lineage',
                                  'GET /api/v1/cases/:id/calculation/delta',
                                  'GET /api/v1/cases/:id/closure')
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/cases/:id/reassess',
                                  'POST /api/v1/cases/:id/close')
       WHERE r.role_code IN ('TA_SUPERVISOR', 'TA_ASSESSOR')
      ON CONFLICT DO NOTHING
    `);

    // A legal hold stops a file being destroyed. Placing or lifting one is an
    // administrative act with consequences for evidence, so it is FULL.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 30, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'POST /api/v1/cases/:id/legal-hold'
       WHERE r.role_code IN ('TA_ADMIN', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    /** Retention periods, per jurisdiction. Configuration, like everything else. */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.master_data (group_code, jurisdiction_code, display_key, description, created_at, updated_at, is_active)
      SELECT 'RETENTION_CLASS', 'GB', 'ta.masters.retentionClass', 'How long a closed file is kept', now(), now(), true
       WHERE NOT EXISTS (
         SELECT 1 FROM platform.master_data
          WHERE group_code = 'RETENTION_CLASS' AND jurisdiction_code = 'GB')
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.master_data_item (master_data_id, item_code, display_key, sort_order, attributes_json, created_at, updated_at, is_active)
      SELECT d.id, v.code, 'ta.retention.' || lower(v.code), v.ord,
             jsonb_build_object('retainYears', v.years), now(), now(), true
        FROM platform.master_data d
        CROSS JOIN (VALUES
          ('STATUTORY', 1, 7),
          ('EXTENDED',  2, 20),
          ('PERMANENT', 3, 0)
        ) AS v(code, ord, years)
       WHERE d.group_code = 'RETENTION_CLASS' AND d.jurisdiction_code = 'GB'
         AND NOT EXISTS (
           SELECT 1 FROM platform.master_data_item i
            WHERE i.master_data_id = d.id AND i.item_code = v.code)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.master_data_item WHERE master_data_id IN
        (SELECT id FROM platform.master_data WHERE group_code = 'RETENTION_CLASS')
    `);
    await queryInterface.sequelize.query(
      `DELETE FROM platform.master_data WHERE group_code = 'RETENTION_CLASS'`,
    );
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (SELECT id FROM platform.permission
                                WHERE permission_key LIKE '%reassess%'
                                   OR permission_key LIKE '%/close'
                                   OR permission_key LIKE '%/closure'
                                   OR permission_key LIKE '%/lineage'
                                   OR permission_key LIKE '%legal-hold'
                                   OR permission_key LIKE '%calculation/delta')
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM platform.permission
       WHERE permission_key LIKE '%reassess%'
          OR permission_key LIKE '%/close'
          OR permission_key LIKE '%/closure'
          OR permission_key LIKE '%/lineage'
          OR permission_key LIKE '%legal-hold'
          OR permission_key LIKE '%calculation/delta'
    `);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS tax.ix_case_predecessor`);
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_case_closure' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_reassessment' });
  },
};
