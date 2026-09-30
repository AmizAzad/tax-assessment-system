'use strict';

/**
 * Register the six routes nobody could reach, and take back grants that
 * reached too far.
 *
 * Plan reference: V2 sections 5.4, 9.3, 13.4, 19.2, 20; ADR-003.
 *
 * ## Found by comparing the router with the catalogue
 *
 * The guard fails closed: a route missing from `platform.permission` is
 * refused to every caller, whatever role they hold. Listing every route Nest
 * maps at boot against the catalogue found six that shipped without a row:
 *
 * | Route                             | Symptom                                          |
 * | --------------------------------- | ------------------------------------------------ |
 * | `GET /objections/:uuid/deposit`   | an objection officer cannot see the deposit due  |
 * | `GET /processes/cases/:id`        | the process instance behind a case is unreadable |
 * | `POST /processes/validate`        | the modeller cannot check a diagram              |
 * | `POST /processes/deploy`          | nobody can deploy, so nobody sees the modeller   |
 * | `POST /processes/deploy/standard` | the shipped definition cannot be deployed        |
 * | `POST /rule-sets/:id/simulate`    | a draft rule set cannot be replayed              |
 *
 * The fourth and fifth are why the engine reported "No process definition
 * found for key TAX_ASSESSMENT_MAIN": deployment is deliberately an act rather
 * than a boot step, and the act was refused to everyone.
 *
 * Each is granted the way its neighbours already are, so no role gains a
 * capability its sibling routes did not already give it. The two reads go to
 * whoever already holds the route beside them (the objection itself, and the
 * case's process journey). The four configuration changes go to `TA_ADMIN`
 * alone: deploying a process changes how every later case is coordinated,
 * and a simulation replays other taxpayers' cases in bulk.
 *
 * ## The selection register was readable by everyone
 *
 * `20261007000100` granted the selection runs and the risk rules to every
 * internal role. A selection run is the list of taxpayers chosen for
 * examination before anyone has opened a case on them, and the risk rules are
 * the thresholds that chose them. Either, in a caseworker's hands, tells a
 * taxpayer's adviser what to keep under. The boundary probe has always
 * asserted that an assessor is refused `/selection/runs`, and the role matrix
 * the end-to-end suite checks never showed the menu to one. The grant was the
 * outlier.
 *
 * Reading them is now kept to the roles that decide or oversee selection: the
 * supervisor who runs it, the administrator who configures it, and the
 * read-only auditor. A caseworker learns a case was selected when it is
 * assigned to them, which is when they need to.
 *
 * ## A taxpayer held officer routes
 *
 * `TA_TAXPAYER` held `POST /cases/:id/objections`, `POST /cases/:id/appeals`
 * and `POST /objections/:uuid/withdraw`. Those are the officer's routes, and
 * they do not resolve the caller's authority to a taxpayer, because an
 * officer acts on any case. A taxpayer token could therefore file an
 * objection against a case that is not theirs by changing the id. The portal
 * has its own objection route that checks recorded authority on every
 * request; that is the taxpayer's door, and the officer routes are closed to
 * them.
 *
 * The taxpayer also held the workflow task inbox and task completion. No
 * process definition assigns a step to a taxpayer, so the inbox was always
 * empty and the menu offered them an officer's screen.
 *
 * ## Rejected
 *
 * Adding ownership checks to the officer routes instead of revoking them.
 * That would make one route serve two audiences with two authorisation
 * models, which is how the check gets forgotten on the next route added.
 */

const NEW_ROUTES = [
  ['GET /api/v1/objections/:uuid/deposit', 'OBJECTIONS', 10, 'What deposit an objection requires'],
  [
    'GET /api/v1/processes/cases/:id',
    'ASSESSMENT_REGISTER',
    10,
    'The process instance coordinating a case',
  ],
  [
    'POST /api/v1/processes/validate',
    'ADMIN',
    10,
    'Check a process definition without deploying it',
  ],
  ['POST /api/v1/processes/deploy', 'ADMIN', 30, 'Validate and deploy a process definition'],
  [
    'POST /api/v1/processes/deploy/standard',
    'ADMIN',
    30,
    'Deploy the assessment definition shipped with this release',
  ],
  [
    'POST /api/v1/rule-sets/:id/simulate',
    'RULE_CONFIG',
    30,
    'Replay a draft rule set over historic cases',
  ],
];

/** New read route -> the existing route whose holders it follows. */
const READS_FOLLOW = [
  ['GET /api/v1/objections/:uuid/deposit', 'GET /api/v1/objections/:uuid'],
  ['GET /api/v1/processes/cases/:id', 'GET /api/v1/processes/cases/:id/journey'],
];

const ADMIN_ONLY = [
  'POST /api/v1/processes/validate',
  'POST /api/v1/processes/deploy',
  'POST /api/v1/processes/deploy/standard',
  'POST /api/v1/rule-sets/:id/simulate',
];

const SELECTION_READS = [
  'GET /api/v1/selection/runs',
  'GET /api/v1/selection/runs/:id',
  'GET /api/v1/risk-rules',
];
const SELECTION_READERS = ['TA_SUPERVISOR', 'TA_ADMIN', 'TA_AUDITOR_READONLY'];

const TAXPAYER_REVOKED = [
  ['POST /api/v1/cases/:id/objections', 20],
  ['POST /api/v1/cases/:id/appeals', 20],
  ['POST /api/v1/objections/:uuid/withdraw', 20],
  ['GET /api/v1/workflow/tasks', 10],
  ['POST /api/v1/workflow/tasks/:taskId/complete', 20],
];

module.exports = {
  async up(queryInterface) {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    for (const [key, menu, level, description] of NEW_ROUTES) {
      await q(
        `INSERT INTO platform.permission
                (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
         SELECT :key, m.id, :level, :description, now(), now(), true
           FROM platform.menu m
          WHERE m.menu_code = :menu
         ON CONFLICT (permission_key) DO NOTHING`,
        { key, menu, level, description },
      );
    }

    for (const [route, follows] of READS_FOLLOW) {
      await q(
        `INSERT INTO platform.role_permission
                (role_id, permission_id, granted_level, created_at, updated_at, is_active)
         SELECT existing.role_id, p.id, 10, now(), now(), true
           FROM platform.role_permission existing
           JOIN platform.permission f ON f.id = existing.permission_id AND f.permission_key = :follows
           JOIN platform.permission p ON p.permission_key = :route
          WHERE existing.is_active
         ON CONFLICT DO NOTHING`,
        { route, follows },
      );
    }

    await q(
      `INSERT INTO platform.role_permission
              (role_id, permission_id, granted_level, created_at, updated_at, is_active)
       SELECT r.id, p.id, 30, now(), now(), true
         FROM platform.role r
         JOIN platform.permission p ON p.permission_key IN (:keys)
        WHERE r.role_code = 'TA_ADMIN'
       ON CONFLICT DO NOTHING`,
      { keys: ADMIN_ONLY },
    );

    await q(
      `DELETE FROM platform.role_permission rp
        USING platform.role r, platform.permission p
        WHERE rp.role_id = r.id
          AND rp.permission_id = p.id
          AND p.permission_key IN (:keys)
          AND r.role_code NOT IN (:keep)`,
      { keys: SELECTION_READS, keep: SELECTION_READERS },
    );

    await q(
      `DELETE FROM platform.role_permission rp
        USING platform.role r, platform.permission p
        WHERE rp.role_id = r.id
          AND rp.permission_id = p.id
          AND r.role_code = 'TA_TAXPAYER'
          AND p.permission_key IN (:keys)`,
      { keys: TAXPAYER_REVOKED.map(([key]) => key) },
    );
  },

  async down(queryInterface) {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    for (const [key, level] of TAXPAYER_REVOKED) {
      await q(
        `INSERT INTO platform.role_permission
                (role_id, permission_id, granted_level, created_at, updated_at, is_active)
         SELECT r.id, p.id, :level, now(), now(), true
           FROM platform.role r
           JOIN platform.permission p ON p.permission_key = :key
          WHERE r.role_code = 'TA_TAXPAYER'
         ON CONFLICT DO NOTHING`,
        { key, level },
      );
    }

    await q(
      `INSERT INTO platform.role_permission
              (role_id, permission_id, granted_level, created_at, updated_at, is_active)
       SELECT r.id, p.id, 10, now(), now(), true
         FROM platform.role r
         JOIN platform.permission p ON p.permission_key IN (:keys)
        WHERE r.role_type = 'INTERNAL'
       ON CONFLICT DO NOTHING`,
      { keys: SELECTION_READS },
    );

    const added = NEW_ROUTES.map(([key]) => key);
    await q(
      `DELETE FROM platform.role_permission
        WHERE permission_id IN (SELECT id FROM platform.permission WHERE permission_key IN (:keys))`,
      { keys: added },
    );
    await q(`DELETE FROM platform.permission WHERE permission_key IN (:keys)`, { keys: added });
  },
};
