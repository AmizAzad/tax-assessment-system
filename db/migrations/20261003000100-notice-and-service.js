'use strict';

/**
 * Notices, their service on the taxpayer, and the SLA clock.
 *
 * Plan reference: V2 sections 12.1 to 12.6 (Phase 5, stages 9-10).
 *
 * ## Why a notice is its own record and not just a document
 *
 * A notice is the legal instrument. The PDF is a rendering of it. Those are
 * different things: the same notice may be re-rendered in another language, or
 * re-issued after a correction, and the case must be able to say which notice
 * was served, when, and on what content. Storing only the file would make
 * "which version did the taxpayer actually receive" unanswerable.
 *
 * ## Why service is a separate table from the notice
 *
 * One notice can be served through several channels, each with its own proof
 * and its own outcome: an email that bounced, a registered post that was
 * signed for, a portal message that was read. Deemed service usually turns on
 * the earliest successful one. A single `served_at` column on the notice could
 * not represent a failed channel at all, and a failed channel is exactly what
 * a taxpayer disputes.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { BIGINT, INTEGER, STRING, DATE, DATEONLY, BOOLEAN, TEXT, JSONB } = Sequelize;

    /**
     * The wording of each notice, per jurisdiction, type and language.
     *
     * Configuration, not code. The legal wording of a notice is signed off by
     * lawyers and changes on their timetable, not on a release timetable, and
     * it differs per jurisdiction and per language. A template in a source
     * file would make every wording correction a deployment.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_notice_template' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: Sequelize.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        jurisdiction_code: { type: STRING(3), allowNull: false },
        tax_type_code: { type: STRING(20), allowNull: true },
        notice_type: { type: STRING(40), allowNull: false },
        language_code: { type: STRING(10), allowNull: false, defaultValue: 'en' },
        version: { type: INTEGER, allowNull: false, defaultValue: 1 },

        title_template: { type: TEXT, allowNull: false },
        /**
         * The body, with `{{placeholders}}`.
         *
         * Deliberately a flat token substitution rather than an expression
         * language. A notice template must not be able to compute anything:
         * every figure on a notice comes from the calculation that was
         * approved, and a template that could do arithmetic could disagree
         * with it (ADR-006).
         */
        body_template: { type: TEXT, allowNull: false },
        /** Which placeholders this template requires, for publish-time checking. */
        required_tokens: { type: JSONB, allowNull: false, defaultValue: [] },

        status: { type: STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        effective_from: { type: DATEONLY, allowNull: true },
        effective_to: { type: DATEONLY, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    // One published template per jurisdiction, type and language at a time.
    // Two would make "which wording was used" depend on row order.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_notice_template_published
        ON tax.tax_notice_template (jurisdiction_code, notice_type, language_code)
        WHERE status = 'PUBLISHED' AND is_active
    `);

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_assessment_notice' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: Sequelize.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        case_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
        },
        notice_number: { type: STRING(40), allowNull: false, unique: true },
        notice_type: { type: STRING(40), allowNull: false },

        /** Re-issues increment. The taxpayer may hold an earlier version. */
        version: { type: INTEGER, allowNull: false, defaultValue: 1 },
        language_code: { type: STRING(10), allowNull: false, defaultValue: 'en' },
        template_id: { type: BIGINT, allowNull: true },

        /** The calculation this notice states. Frozen with it. */
        calculation_result_id: { type: BIGINT, allowNull: true },

        /**
         * The substantive content, as rendered.
         *
         * Kept as data rather than only as a PDF so the notice can be
         * re-rendered in another format, or verified, without re-running a
         * calculation that may since have been superseded.
         */
        content_json: { type: JSONB, allowNull: false },
        rendered_title: { type: TEXT, allowNull: false },
        rendered_body: { type: TEXT, allowNull: false },

        /**
         * SHA-256 over the canonical content, not over the PDF bytes.
         *
         * A PDF embeds a creation timestamp, so the same notice rendered twice
         * produces different bytes. Hashing the content instead means
         * verification answers the question that matters: does this document
         * still say what it said when it was served.
         */
        content_hash: { type: STRING(64), allowNull: false },

        /** The rendered PDF in the document store. */
        document_id: { type: BIGINT, allowNull: true },

        status: { type: STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        issued_at: { type: DATE, allowNull: true },
        issued_by: { type: BIGINT, allowNull: true },

        /**
         * Earliest effective service across all channels, and the date the law
         * treats as service. They differ: post is commonly deemed served some
         * days after despatch whether or not it was read.
         */
        first_served_at: { type: DATE, allowNull: true },
        deemed_served_on: { type: DATEONLY, allowNull: true },

        superseded_by_notice_id: { type: BIGINT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_assessment_notice' },
      ['case_id', 'notice_type'],
      { name: 'ix_notice_case_type' },
    );

    // One live notice of a given type and version per case.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_notice_case_type_version
        ON tax.tax_assessment_notice (case_id, notice_type, version)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_assessment_notice
        ADD CONSTRAINT notice_status_valid
        CHECK (status IN ('DRAFT', 'ISSUED', 'SERVED', 'SUPERSEDED', 'CANCELLED'))
    `);

    // A notice that claims to be served must say when. Without this the
    // objection window has no start date and cannot be computed.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_assessment_notice
        ADD CONSTRAINT notice_served_has_date
        CHECK (status <> 'SERVED' OR (first_served_at IS NOT NULL AND deemed_served_on IS NOT NULL))
    `);

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_notice_service' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: Sequelize.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        notice_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_notice' }, key: 'id' },
        },

        channel: { type: STRING(20), allowNull: false },
        addressee: { type: STRING(320), allowNull: false },
        /** Where it was sent, captured at despatch: addresses change. */
        address_snapshot: { type: JSONB, allowNull: true },

        dispatched_at: { type: DATE, allowNull: true },
        delivered_at: { type: DATE, allowNull: true },
        read_at: { type: DATE, allowNull: true },
        failed_at: { type: DATE, allowNull: true },
        failure_reason: { type: TEXT, allowNull: true },

        /** Tracking number, message id, signature image reference. */
        proof_reference: { type: STRING(200), allowNull: true },
        proof_document_id: { type: BIGINT, allowNull: true },

        /**
         * When this channel is treated as having served the notice.
         *
         * Set from the channel's deemed-service rule at despatch, because the
         * rule in force at despatch is the one that governs.
         */
        deemed_served_on: { type: DATEONLY, allowNull: true },
        status: { type: STRING(20), allowNull: false, defaultValue: 'PENDING' },

        notification_id: { type: BIGINT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_notice_service' },
      ['notice_id'],
      { name: 'ix_notice_service_notice' },
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_notice_service
        ADD CONSTRAINT notice_service_status_valid
        CHECK (status IN ('PENDING', 'DISPATCHED', 'DELIVERED', 'READ', 'FAILED', 'RETURNED'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_notice_service
        ADD CONSTRAINT notice_service_channel_valid
        CHECK (channel IN ('EMAIL', 'SMS', 'PORTAL', 'REGISTERED_POST', 'HAND_DELIVERY', 'PUBLICATION'))
    `);

    // A failure must say why. "FAILED" with no reason cannot be actioned by
    // the officer who has to serve it another way.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_notice_service
        ADD CONSTRAINT notice_service_failure_explained
        CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL)
    `);

    /**
     * Deemed-service rules per channel.
     *
     * "Served two working days after posting" is a statutory rule, varies per
     * jurisdiction and channel, and decides when an objection window opens. It
     * belongs in configuration for the same reason the deadline offsets do.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_service_rule' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: STRING(3), allowNull: false },
        channel: { type: STRING(20), allowNull: false },
        /** Days after despatch on which service is deemed to occur. */
        deemed_after_value: { type: INTEGER, allowNull: false, defaultValue: 0 },
        deemed_after_unit: { type: STRING(10), allowNull: false, defaultValue: 'DAYS' },
        calendar_rule: { type: STRING(20), allowNull: false, defaultValue: 'CALENDAR_DAYS' },
        /** Whether actual earlier delivery overrides the deemed date. */
        actual_delivery_wins: { type: BOOLEAN, allowNull: false, defaultValue: true },
        effective_from: { type: DATEONLY, allowNull: true },
        effective_to: { type: DATEONLY, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_service_rule_channel
        ON tax.tax_service_rule (jurisdiction_code, channel)
        WHERE is_active
    `);

    /**
     * Internal processing clocks.
     *
     * Distinct from `tax_assessment_deadline`, which holds statutory dates a
     * taxpayer is bound by. An SLA is an administrative target the authority
     * sets for itself. Conflating them would let an internal target breach and
     * look like a legal one, or let a missed service standard be argued as a
     * time bar.
     */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_sla_tracker' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        case_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_assessment_case' }, key: 'id' },
        },
        sla_code: { type: STRING(40), allowNull: false },
        stage_code: { type: STRING(40), allowNull: true },
        started_at: { type: DATE, allowNull: false },
        target_at: { type: DATE, allowNull: false },
        completed_at: { type: DATE, allowNull: true },
        warned_at: { type: DATE, allowNull: true },
        breached_at: { type: DATE, allowNull: true },
        status: { type: STRING(20), allowNull: false, defaultValue: 'RUNNING' },
        owner_user_id: { type: BIGINT, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_sla_tracker' },
      ['case_id', 'sla_code'],
      { name: 'ix_sla_case' },
    );

    // The scheduler sweeps for breaches; without this index that is a table
    // scan on every tick once the register is large.
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_sla_running_target
        ON tax.tax_sla_tracker (target_at)
        WHERE status = 'RUNNING' AND is_active
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX ix_deadline_open_due
        ON tax.tax_assessment_deadline (due_at)
        WHERE status = 'OPEN' AND is_active
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('POST /api/v1/cases/:id/notices',                1, 20, 'Generate a notice', now(), now(), true),
        ('GET /api/v1/cases/:id/notices',                 1, 10, 'List notices on a case', now(), now(), true),
        ('GET /api/v1/notices/:uuid',                     1, 10, 'Read a notice', now(), now(), true),
        ('GET /api/v1/notices/:uuid/verify',              1, 10, 'Verify a notice has not been altered', now(), now(), true),
        ('GET /api/v1/notices/:uuid/document',            1, 10, 'Download the rendered notice', now(), now(), true),
        ('POST /api/v1/notices/:uuid/serve',              1, 20, 'Serve a notice through a channel', now(), now(), true),
        ('POST /api/v1/notices/:uuid/service/:serviceId/outcome', 1, 20, 'Record a service outcome', now(), now(), true),
        ('GET /api/v1/cases/:id/sla',                     1, 10, 'SLA clocks on a case', now(), now(), true),
        ('GET /api/v1/notice-templates',                  1, 10, 'Notice wording templates', now(), now(), true),
        ('POST /api/v1/notice-templates/:id/publish',     1, 30, 'Publish notice wording', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // Reading notices is open to internal roles: a reviewer who cannot see the
    // notice cannot check what the taxpayer was told.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('GET /api/v1/cases/:id/notices',
                                  'GET /api/v1/notices/:uuid',
                                  'GET /api/v1/notices/:uuid/verify',
                                  'GET /api/v1/notices/:uuid/document',
                                  'GET /api/v1/cases/:id/sla',
                                  'GET /api/v1/notice-templates')
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/cases/:id/notices',
                                  'POST /api/v1/notices/:uuid/serve',
                                  'POST /api/v1/notices/:uuid/service/:serviceId/outcome')
       WHERE r.role_code IN ('TA_NOTICE_ISSUER', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 30, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key = 'POST /api/v1/notice-templates/:id/publish'
       WHERE r.role_code IN ('TA_ADMIN', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (SELECT id FROM platform.permission
                                WHERE permission_key LIKE '%notice%' OR permission_key LIKE '%/sla')
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM platform.permission
       WHERE permission_key LIKE '%notice%' OR permission_key LIKE '%/sla'
    `);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS tax.ix_deadline_open_due`);
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_sla_tracker' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_service_rule' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_notice_service' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_assessment_notice' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_notice_template' });
  },
};
