'use strict';

/**
 * Objections and appeals.
 *
 * Plan reference: V2 sections 13.1 to 13.7 (Phase 6, stages 11-12).
 *
 * ## Why admissibility is recorded rather than enforced
 *
 * An objection filed after the window has closed is not automatically void.
 * Most jurisdictions allow late filing to be admitted for good cause -- the
 * taxpayer was in hospital, the notice went to a former address. So the
 * platform computes whether an objection is in time, records the answer and
 * the reason, and requires a person to decide. A system that silently rejected
 * late objections would remove a discretion the law grants.
 *
 * ## Why the committee opinion is its own table
 *
 * Where a jurisdiction requires a panel, "the committee decided" is not one
 * fact: it is several people's opinions and a resulting decision. A single
 * decision column could not show a dissent, and a dissent is exactly what a
 * later appeal will ask about.
 *
 * ## Why an appeal points at both the case and the objection
 *
 * An appeal is against the objection decision, but it is about the assessment.
 * Both links are needed: one to find what is being challenged, the other to
 * know which figures move when the appeal succeeds.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { BIGINT, INTEGER, STRING, DECIMAL, DATE, DATEONLY, BOOLEAN, TEXT, JSONB } = Sequelize;

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_objection' },
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
        notice_id: { type: BIGINT, allowNull: true },
        objection_number: { type: STRING(40), allowNull: false, unique: true },

        filed_on: { type: DATEONLY, allowNull: false },
        filed_by_user_id: { type: BIGINT, allowNull: true },
        /** How the objection reached the authority, for the file. */
        filed_channel: { type: STRING(20), allowNull: false, defaultValue: 'PORTAL' },

        grounds_summary: { type: TEXT, allowNull: false },
        requested_relief: { type: DECIMAL(20, 4), allowNull: true },
        currency_code: { type: STRING(3), allowNull: true },

        /**
         * Whether it arrived in time, computed against the objection deadline.
         *
         * Kept separately from the admissibility decision because they answer
         * different questions: one is arithmetic, the other is judgement.
         */
        was_in_time: { type: BOOLEAN, allowNull: false },
        deadline_on: { type: DATEONLY, allowNull: true },
        days_late: { type: INTEGER, allowNull: false, defaultValue: 0 },

        admissibility: { type: STRING(20), allowNull: false, defaultValue: 'PENDING' },
        admissibility_reason: { type: TEXT, allowNull: true },
        admitted_by: { type: BIGINT, allowNull: true },
        admitted_at: { type: DATE, allowNull: true },

        /**
         * Some jurisdictions require part of the disputed tax to be deposited
         * before an objection is heard. Where none is required both columns
         * stay null, which reads differently from a deposit of zero.
         */
        deposit_required: { type: DECIMAL(20, 4), allowNull: true },
        deposit_paid: { type: DECIMAL(20, 4), allowNull: true },

        /**
         * Whether collection is suspended while the objection runs.
         *
         * Explicit rather than derived from the objection's existence: the
         * answer differs per jurisdiction, and getting it wrong either chases
         * a taxpayer who is protected or fails to chase one who is not.
         */
        collection_stayed: { type: BOOLEAN, allowNull: false, defaultValue: false },

        status: { type: STRING(30), allowNull: false, defaultValue: 'FILED' },
        decision: { type: STRING(30), allowNull: true },
        decision_reason: { type: TEXT, allowNull: true },
        decided_by: { type: BIGINT, allowNull: true },
        decided_on: { type: DATEONLY, allowNull: true },
        /** The calculation the decision produces, once a reassessment runs. */
        revised_calculation_id: { type: BIGINT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex({ schema: 'tax', tableName: 'tax_objection' }, ['case_id'], {
      name: 'ix_objection_case',
    });

    // One live objection per case. A second one against the same assessment is
    // an amendment to the first, not a parallel dispute.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_objection_open_per_case
        ON tax.tax_objection (case_id)
        WHERE is_active AND status NOT IN ('WITHDRAWN', 'DECIDED', 'REJECTED_INADMISSIBLE')
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_objection
        ADD CONSTRAINT objection_admissibility_valid
        CHECK (admissibility IN ('PENDING', 'ADMITTED', 'INADMISSIBLE'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_objection
        ADD CONSTRAINT objection_status_valid
        CHECK (status IN ('FILED', 'UNDER_CONSIDERATION', 'AWAITING_DEPOSIT', 'DECIDED',
                          'WITHDRAWN', 'REJECTED_INADMISSIBLE'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_objection
        ADD CONSTRAINT objection_decision_valid
        CHECK (decision IS NULL OR decision IN ('ALLOWED', 'PARTLY_ALLOWED', 'REJECTED'))
    `);

    // A decision without a reason cannot be appealed against intelligibly, and
    // in most jurisdictions is itself a ground of appeal.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_objection
        ADD CONSTRAINT objection_decision_explained
        CHECK (decision IS NULL OR (decision_reason IS NOT NULL AND decided_on IS NOT NULL))
    `);

    // Declaring something inadmissible is a refusal to hear a person. It must
    // say why.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_objection
        ADD CONSTRAINT objection_inadmissible_explained
        CHECK (admissibility <> 'INADMISSIBLE' OR admissibility_reason IS NOT NULL)
    `);

    /** The specific grounds relied on, against the jurisdiction's vocabulary. */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_objection_ground' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        objection_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_objection' }, key: 'id' },
        },
        ground_code: { type: STRING(40), allowNull: false },
        detail: { type: TEXT, allowNull: true },
        /** Which adjustment or line the ground attacks, where it names one. */
        adjustment_id: { type: BIGINT, allowNull: true },
        disputed_amount: { type: DECIMAL(20, 4), allowNull: true },
        /** Decided per ground: an objection can succeed on one and fail on another. */
        outcome: { type: STRING(20), allowNull: true },
        outcome_reason: { type: TEXT, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_objection_ground' },
      ['objection_id'],
      { name: 'ix_objection_ground_objection' },
    );

    /** Individual opinions where a panel considers the objection. */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_objection_opinion' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        objection_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_objection' }, key: 'id' },
        },
        member_user_id: { type: BIGINT, allowNull: false },
        opinion: { type: STRING(30), allowNull: false },
        reasoning: { type: TEXT, allowNull: true },
        given_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    // One opinion per member per objection: a second is a change of mind and
    // should replace the first rather than be counted twice in a vote.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_objection_opinion_member
        ON tax.tax_objection_opinion (objection_id, member_user_id)
        WHERE is_active
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_objection_opinion
        ADD CONSTRAINT objection_opinion_valid
        CHECK (opinion IN ('ALLOW', 'PARTLY_ALLOW', 'REJECT', 'ABSTAIN'))
    `);

    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_appeal' },
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
        objection_id: { type: BIGINT, allowNull: true },
        appeal_number: { type: STRING(40), allowNull: false, unique: true },

        /** Tribunal or court, from the jurisdiction's APPEAL_FORUM master data. */
        forum_code: { type: STRING(40), allowNull: false },
        /** The forum's own case number, where it issues one. */
        external_reference: { type: STRING(100), allowNull: true },

        filed_on: { type: DATEONLY, allowNull: false },
        filed_by: { type: STRING(20), allowNull: false, defaultValue: 'TAXPAYER' },
        was_in_time: { type: BOOLEAN, allowNull: false, defaultValue: true },
        deadline_on: { type: DATEONLY, allowNull: true },
        days_late: { type: INTEGER, allowNull: false, defaultValue: 0 },

        grounds_summary: { type: TEXT, allowNull: false },
        disputed_amount: { type: DECIMAL(20, 4), allowNull: true },
        currency_code: { type: STRING(3), allowNull: true },
        collection_stayed: { type: BOOLEAN, allowNull: false, defaultValue: false },

        status: { type: STRING(30), allowNull: false, defaultValue: 'FILED' },
        outcome: { type: STRING(30), allowNull: true },
        outcome_reason: { type: TEXT, allowNull: true },
        decided_on: { type: DATEONLY, allowNull: true },

        /**
         * Whether the authority has given effect to the decision.
         *
         * An appeal that is won and never implemented is the failure mode that
         * matters here: the taxpayer holds a judgment and the register still
         * shows the old figure.
         */
        implemented_at: { type: DATE, allowNull: true },
        implementation_note: { type: TEXT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex({ schema: 'tax', tableName: 'tax_appeal' }, ['case_id'], {
      name: 'ix_appeal_case',
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_appeal
        ADD CONSTRAINT appeal_status_valid
        CHECK (status IN ('FILED', 'LISTED', 'HEARD', 'DECIDED', 'WITHDRAWN', 'STRUCK_OUT'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_appeal
        ADD CONSTRAINT appeal_outcome_valid
        CHECK (outcome IS NULL OR outcome IN ('UPHELD', 'VARIED', 'SET_ASIDE', 'REMANDED'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_appeal
        ADD CONSTRAINT appeal_outcome_explained
        CHECK (outcome IS NULL OR (outcome_reason IS NOT NULL AND decided_on IS NOT NULL))
    `);

    /** Hearings, listings and adjournments. */
    await queryInterface.createTable(
      { schema: 'tax', tableName: 'tax_appeal_hearing' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        appeal_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'tax', tableName: 'tax_appeal' }, key: 'id' },
        },
        scheduled_for: { type: DATE, allowNull: false },
        venue: { type: STRING(200), allowNull: true },
        /** Who attended for the authority, for the file. */
        representative: { type: STRING(200), allowNull: true },
        outcome: { type: STRING(30), allowNull: true },
        notes: { type: TEXT, allowNull: true },
        adjourned_to: { type: DATE, allowNull: true },
        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex(
      { schema: 'tax', tableName: 'tax_appeal_hearing' },
      ['appeal_id'],
      { name: 'ix_appeal_hearing_appeal' },
    );

    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('POST /api/v1/cases/:id/objections',              1, 20, 'File an objection', now(), now(), true),
        ('GET /api/v1/cases/:id/objections',               1, 10, 'Objections on a case', now(), now(), true),
        ('GET /api/v1/objections/:uuid',                   1, 10, 'Read an objection', now(), now(), true),
        ('POST /api/v1/objections/:uuid/admissibility',    1, 20, 'Decide admissibility', now(), now(), true),
        ('POST /api/v1/objections/:uuid/opinions',         1, 20, 'Give a committee opinion', now(), now(), true),
        ('POST /api/v1/objections/:uuid/decision',         1, 20, 'Decide an objection', now(), now(), true),
        ('POST /api/v1/objections/:uuid/withdraw',         1, 20, 'Withdraw an objection', now(), now(), true),
        ('POST /api/v1/cases/:id/appeals',                 1, 20, 'File an appeal', now(), now(), true),
        ('GET /api/v1/cases/:id/appeals',                  1, 10, 'Appeals on a case', now(), now(), true),
        ('GET /api/v1/appeals/:uuid',                      1, 10, 'Read an appeal', now(), now(), true),
        ('POST /api/v1/appeals/:uuid/hearings',            1, 20, 'List a hearing', now(), now(), true),
        ('POST /api/v1/appeals/:uuid/outcome',             1, 20, 'Record an appeal outcome', now(), now(), true),
        ('POST /api/v1/appeals/:uuid/implement',           1, 20, 'Implement an appeal decision', now(), now(), true),
        ('GET /api/v1/disputes',                           1, 10, 'The dispute register', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('GET /api/v1/cases/:id/objections',
                                  'GET /api/v1/objections/:uuid',
                                  'GET /api/v1/cases/:id/appeals',
                                  'GET /api/v1/appeals/:uuid',
                                  'GET /api/v1/disputes')
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);

    // Objection handling belongs to the objection officer, not to the assessor
    // whose work is being challenged. Deciding an objection on your own
    // assessment is the conflict this whole stage exists to avoid.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/objections/:uuid/admissibility',
                                  'POST /api/v1/objections/:uuid/opinions',
                                  'POST /api/v1/objections/:uuid/decision')
       WHERE r.role_code IN ('TA_OBJECTION_OFFICER', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/appeals/:uuid/hearings',
                                  'POST /api/v1/appeals/:uuid/outcome',
                                  'POST /api/v1/appeals/:uuid/implement')
       WHERE r.role_code IN ('TA_APPEALS_OFFICER', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);

    // Filing is the taxpayer's own act. Officers may file on their behalf,
    // because objections still arrive on paper in every jurisdiction.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/cases/:id/objections',
                                  'POST /api/v1/objections/:uuid/withdraw',
                                  'POST /api/v1/cases/:id/appeals')
       WHERE r.role_code IN ('TA_TAXPAYER', 'TA_OBJECTION_OFFICER', 'TA_APPEALS_OFFICER', 'TA_SUPERVISOR')
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (SELECT id FROM platform.permission
                                WHERE permission_key LIKE '%objection%'
                                   OR permission_key LIKE '%appeal%'
                                   OR permission_key LIKE '%/disputes')
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM platform.permission
       WHERE permission_key LIKE '%objection%'
          OR permission_key LIKE '%appeal%'
          OR permission_key LIKE '%/disputes'
    `);
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_appeal_hearing' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_appeal' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_objection_opinion' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_objection_ground' });
    await queryInterface.dropTable({ schema: 'tax', tableName: 'tax_objection' });
  },
};
