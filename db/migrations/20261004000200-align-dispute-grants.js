'use strict';

/**
 * Make the permission grants agree with the case state machine.
 *
 * Plan reference: V2 sections 6.3, 13.3.
 *
 * ## What this fixes
 *
 * `20261004000100` granted the supervisor role permission to decide
 * objections. The transition table in `@tas/contracts` names only
 * `TA_OBJECTION_OFFICER` as an actor on `DECIDE_ALLOWED`,
 * `DECIDE_PARTLY_ALLOWED` and `DECIDE_REJECTED`, so a supervisor passed the
 * route check and was then refused by the state machine. Two layers
 * disagreeing is worse than either rule alone: the caller is told they may do
 * something and then told they may not.
 *
 * ## Which one wins, and why
 *
 * The state machine. "Who may decide an objection" should have exactly one
 * answer, and a supervisor who genuinely needs to decide objections in a small
 * authority should hold the objection officer role rather than route around
 * it. Widening the transition instead would mean the control could be
 * satisfied by seniority, which is the opposite of what separating the
 * objection function is for.
 *
 * Reading objections and overseeing the register stay open to supervisors.
 * Only the act of deciding is narrowed.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission rp
       USING platform.permission p, platform.role r
       WHERE rp.permission_id = p.id
         AND rp.role_id = r.id
         AND r.role_code = 'TA_SUPERVISOR'
         AND p.permission_key IN ('POST /api/v1/objections/:uuid/admissibility',
                                  'POST /api/v1/objections/:uuid/opinions',
                                  'POST /api/v1/objections/:uuid/decision')
    `);

    // Same shape on the appeal side: only the appeals officer records what a
    // forum held, because that is a transcription duty with its own
    // accountability.
    await queryInterface.sequelize.query(`
      DELETE FROM platform.role_permission rp
       USING platform.permission p, platform.role r
       WHERE rp.permission_id = p.id
         AND rp.role_id = r.id
         AND r.role_code = 'TA_SUPERVISOR'
         AND p.permission_key IN ('POST /api/v1/appeals/:uuid/outcome',
                                  'POST /api/v1/appeals/:uuid/implement')
    `);

    /**
     * Committee members may give an opinion.
     *
     * They do not decide: the objection officer does. Opinions are advisory
     * and recorded so a dissent survives into any later appeal.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key = 'POST /api/v1/objections/:uuid/opinions'
       WHERE r.role_code = 'TA_COMMITTEE_MEMBER'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 20, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p
          ON p.permission_key IN ('POST /api/v1/objections/:uuid/admissibility',
                                  'POST /api/v1/objections/:uuid/opinions',
                                  'POST /api/v1/objections/:uuid/decision',
                                  'POST /api/v1/appeals/:uuid/outcome',
                                  'POST /api/v1/appeals/:uuid/implement')
       WHERE r.role_code = 'TA_SUPERVISOR'
      ON CONFLICT DO NOTHING
    `);
  },
};
