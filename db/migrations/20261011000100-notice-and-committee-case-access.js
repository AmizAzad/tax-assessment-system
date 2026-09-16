'use strict';

/**
 * Let the notice issuer and the committee member reach a case.
 *
 * Plan reference: V2 sections 9.2, 9.3, 8.2 stages 9 and 12.
 *
 * ## The defect
 *
 * Both roles held every sub-resource of a case — `GET /cases/:id/notices`,
 * `/objections`, `/evidence`, `/deadlines`, `/lineage` — and **not the case
 * itself**. Neither `GET /api/v1/cases` nor `GET /api/v1/cases/:id`.
 *
 * Every one of those sub-resources is a tab inside the assessment workbench,
 * and the workbench loads the case before it renders a tab. So a notice
 * issuer signing in could not open a single case, and therefore could not
 * issue or serve a notice: the only thing their role exists to do. A
 * committee member could not reach the objection they were convened for.
 *
 * It was invisible from the API, where the walkthrough opens cases as a
 * supervisor and then calls `/notices` directly with the issuer's token. It
 * took driving the screens as each role in turn to find it — which is what
 * the end-to-end suite was written for.
 *
 * ## Why the register is unscoped for the notice issuer and not the committee
 *
 * The register shows an officer the cases they are **assigned** to, and
 * neither of these roles is ever assigned one. Without a further change they
 * would gain the route and still see an empty list.
 *
 * A notice issuer serves notices for the office, not for a caseload — the
 * work arrives because an assessment was finalised, not because it was given
 * to them. So they read the whole register, like a supervisor.
 *
 * A committee member is different: they are convened for a particular
 * objection and have no business browsing the register. They get
 * `GET /cases/:id` so the link from the disputes list opens, and no listing
 * route. Reaching a case requires already knowing which one.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'GET /api/v1/cases/:id'
       WHERE r.role_code IN ('TA_NOTICE_ISSUER', 'TA_COMMITTEE_MEMBER')
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key IN (
               'GET /api/v1/cases',
               'GET /api/v1/grids/:key',
               'GET /api/v1/cases/:id/timeline'
             )
       WHERE r.role_code = 'TA_NOTICE_ISSUER'
      ON CONFLICT DO NOTHING
    `);

    // The timeline is how either of them answers "what happened to this case
    // before it reached me", which is the first question on a returned letter
    // or a late objection.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'GET /api/v1/cases/:id/timeline'
       WHERE r.role_code = 'TA_COMMITTEE_MEMBER'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission rp
       USING platform.role r, platform.permission p
       WHERE rp.role_id = r.id
         AND rp.permission_id = p.id
         AND r.role_code IN ('TA_NOTICE_ISSUER', 'TA_COMMITTEE_MEMBER')
         AND p.permission_key IN (
               'GET /api/v1/cases',
               'GET /api/v1/cases/:id',
               'GET /api/v1/cases/:id/timeline',
               'GET /api/v1/grids/:key')
    `);
  },
};
