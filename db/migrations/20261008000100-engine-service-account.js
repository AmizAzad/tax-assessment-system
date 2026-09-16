'use strict';

/**
 * The identity the process engine acts under.
 *
 * Plan reference: V2 sections 5.3, 6.3; ADR-002.
 *
 * ## Why the engine needs an identity at all
 *
 * `apiInvoker` calls ordinary API routes, and every route is behind the
 * authorisation guard. Before this, the engine sent a static bearer token the
 * API could not verify and every call was refused with a 401 — which the
 * process then turned into an unhandled `BpmnError` and a failed start.
 *
 * ## Why SYSTEM is a real role and not a bypass
 *
 * The tempting shortcut is a shared secret that skips authorisation. That
 * would give the engine unlimited access to every endpoint, authenticated by a
 * string in a config file, and nothing in the audit trail would distinguish it
 * from a person.
 *
 * Instead the engine is a Keycloak service account holding one role, and that
 * role is granted exactly the routes the shipped process definition calls:
 * refreshing evidence, and applying a transition. Adding a service task that
 * calls something else means granting that route deliberately.
 *
 * The transition route is the widest of the two, and it is still bounded: the
 * case state machine names SYSTEM as an actor on only a handful of actions, so
 * a compromised engine token could not approve an assessment or decide an
 * objection.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role (role_code, role_name, description, role_type, created_at, updated_at, is_active)
      VALUES ('SYSTEM', 'Platform', 'Automated actions taken by the platform itself', 'SYSTEM', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    /**
     * Exactly what the shipped definition calls, and nothing else.
     *
     * `evidence/refresh` because retrieval is a service task; `transition`
     * because the boundary timer closes the response window. Both are also
     * SYSTEM-only actions in the state machine, so the two layers agree.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/cases/:id/evidence/refresh',
                                  'POST /api/v1/cases/:id/transition')
       WHERE r.role_code = 'SYSTEM'
      ON CONFLICT DO NOTHING
    `);

    // Reading a case, so the engine can resolve variables without a second
    // identity. VIEW only.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'GET /api/v1/cases/:id'
       WHERE r.role_code = 'SYSTEM'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission
       WHERE role_id IN (SELECT id FROM platform.role WHERE role_code = 'SYSTEM')
    `);
    await queryInterface.sequelize.query(`DELETE FROM platform.role WHERE role_code = 'SYSTEM'`);
  },
};
