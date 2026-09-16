'use strict';

/**
 * Who may act for a taxpayer online.
 *
 * Plan reference: V2 sections 15.1 to 15.4 (Phase 6, taxpayer portal).
 *
 * ## Why this is a table and not a column
 *
 * A company's tax affairs are handled by more than one person: a finance
 * director, an external agent, sometimes a second agent for one period only.
 * A `taxpayer_id` column on the user would force one person per taxpayer and
 * one taxpayer per person, and neither is true.
 *
 * ## Why authority is explicit and dated
 *
 * An agent's authority ends. A director leaves. Both must stop seeing the
 * taxpayer's assessments the day that happens, and the record of when they
 * could see them has to survive, because the question asked afterwards is
 * always "who had access on the date this was disclosed".
 *
 * So the link carries its own validity dates and is never deleted, only
 * ended. The portal reads only links in force today.
 *
 * ## The scoping rule this table exists to support
 *
 * Every portal endpoint resolves the caller's taxpayer from this table and
 * filters on it in SQL. A taxpayer never passes an identifier that selects
 * whose data they see; if they could, the identifier would be the access
 * control, and identifiers are guessable.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { BIGINT, STRING, DATE, DATEONLY, BOOLEAN, TEXT } = Sequelize;

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'taxpayer_user' },
      {
        id: { type: BIGINT, primaryKey: true, autoIncrement: true },
        taxpayer_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'taxpayer' }, key: 'id' },
        },
        user_id: {
          type: BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'app_user' }, key: 'id' },
        },

        /** OWNER is the taxpayer themselves; AGENT acts under an authority. */
        relationship: { type: STRING(20), allowNull: false, defaultValue: 'OWNER' },
        /** The engagement letter or authority reference, where there is one. */
        authority_reference: { type: STRING(100), allowNull: true },

        valid_from: { type: DATEONLY, allowNull: false },
        valid_to: { type: DATEONLY, allowNull: true },
        ended_reason: { type: TEXT, allowNull: true },

        created_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        created_by: { type: BIGINT, allowNull: true },
        updated_at: { type: DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
        updated_by: { type: BIGINT, allowNull: true },
        is_active: { type: BOOLEAN, allowNull: false, defaultValue: true },
      },
    );

    await queryInterface.addIndex({ schema: 'platform', tableName: 'taxpayer_user' }, ['user_id'], {
      name: 'ix_taxpayer_user_user',
    });

    // One live authority per person per taxpayer. Two would make "is this
    // person authorised" depend on which row was read.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_taxpayer_user_live
        ON platform.taxpayer_user (taxpayer_id, user_id)
        WHERE is_active AND valid_to IS NULL
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE platform.taxpayer_user
        ADD CONSTRAINT taxpayer_user_relationship_valid
        CHECK (relationship IN ('OWNER', 'AGENT', 'REPRESENTATIVE'))
    `);

    // An ended authority must say why, because the question later is always
    // whether access was removed deliberately or by accident.
    await queryInterface.sequelize.query(`
      ALTER TABLE platform.taxpayer_user
        ADD CONSTRAINT taxpayer_user_end_explained
        CHECK (valid_to IS NULL OR ended_reason IS NOT NULL)
    `);

    // ------------------------------------------------------------ permissions

    /**
     * The portal surface.
     *
     * Deliberately small. A taxpayer sees their own assessments, the notices
     * served on them, the objections they have filed, and their account. They
     * file objections and pay deposits. Nothing else.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES
        ('GET /api/v1/portal/me',                        1, 10, 'Who the portal caller acts for', now(), now(), true),
        ('GET /api/v1/portal/cases',                     1, 10, 'My assessments', now(), now(), true),
        ('GET /api/v1/portal/cases/:id',                 1, 10, 'One of my assessments', now(), now(), true),
        ('GET /api/v1/portal/cases/:id/notices',         1, 10, 'Notices served on me', now(), now(), true),
        ('GET /api/v1/portal/notices/:uuid/document',    1, 10, 'Download a notice served on me', now(), now(), true),
        ('GET /api/v1/portal/cases/:id/objections',      1, 10, 'Objections I have filed', now(), now(), true),
        ('POST /api/v1/portal/cases/:id/objections',     1, 20, 'File an objection', now(), now(), true),
        ('GET /api/v1/portal/objections/:uuid/deposit',  1, 10, 'What deposit my objection requires', now(), now(), true),
        ('GET /api/v1/portal/account',                   1, 10, 'My payments, credits and losses', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id,
             CASE WHEN p.permission_key LIKE 'POST %' THEN 20 ELSE 10 END,
             now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key LIKE '% /api/v1/portal/%'
       WHERE r.role_code = 'TA_TAXPAYER'
      ON CONFLICT DO NOTHING
    `);

    /**
     * A demonstration taxpayer login.
     *
     * Linked to Acme Trading Ltd so the portal can be seen working against the
     * same case the officer walkthrough uses. The Keycloak user is created
     * alongside it; without both, the link points at nobody.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.app_user (external_subject, username, display_name, email, preferred_language, created_at, updated_at, is_active)
      SELECT 'portal-demo-subject', 'acme-finance', 'Acme Finance Director',
             'finance@acmetrading.example', 'en', now(), now(), true
       WHERE NOT EXISTS (SELECT 1 FROM platform.app_user WHERE username = 'acme-finance')
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.user_role (user_id, role_id, created_at, updated_at, is_active)
      SELECT u.id, r.id, now(), now(), true
        FROM platform.app_user u
        JOIN platform.role r ON r.role_code = 'TA_TAXPAYER'
       WHERE u.username = 'acme-finance'
         AND NOT EXISTS (
           SELECT 1 FROM platform.user_role x WHERE x.user_id = u.id AND x.role_id = r.id)
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.taxpayer_user
        (taxpayer_id, user_id, relationship, valid_from, created_at, updated_at, is_active)
      SELECT t.id, u.id, 'OWNER', '2020-01-01', now(), now(), true
        FROM platform.taxpayer t
        JOIN platform.app_user u ON u.username = 'acme-finance'
       WHERE t.tin = '1234567890'
         AND NOT EXISTS (
           SELECT 1 FROM platform.taxpayer_user x
            WHERE x.taxpayer_id = t.id AND x.user_id = u.id)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE permission_id IN (SELECT id FROM platform.permission
                                WHERE permission_key LIKE '% /api/v1/portal/%')
    `);
    await queryInterface.sequelize.query(
      `DELETE FROM platform.permission WHERE permission_key LIKE '% /api/v1/portal/%'`,
    );
    await queryInterface.dropTable({ schema: 'platform', tableName: 'taxpayer_user' });
    await queryInterface.sequelize.query(`
      DELETE FROM platform.user_role WHERE user_id IN
        (SELECT id FROM platform.app_user WHERE username = 'acme-finance')
    `);
    await queryInterface.sequelize.query(
      `DELETE FROM platform.app_user WHERE username = 'acme-finance'`,
    );
  },
};
