'use strict';

/**
 * Permission rows for the Phase 1 routes.
 *
 * Plan reference: V2 sections 6.1, 9.3, 20.
 *
 * Authorisation fails closed: a route with no row here returns 403 to
 * everyone, administrators included. That is why every new route must be
 * registered in the same migration that introduces it — and why this file is
 * part of the security boundary rather than convenience data.
 *
 * Grants follow the permission matrix in plan 9.3. Two rules shape it:
 *
 *   - `TA_AUDITOR_READONLY` gets VIEW on everything and EDIT on nothing. An
 *     auditor who can change what they audit is not an auditor.
 *   - Configuration routes (templates, reconciliation) are `TA_ADMIN` only.
 *     Publishing a template or repairing the read model are operational acts
 *     with consequences a case worker should not be able to trigger.
 */

const VIEW = 10;
const EDIT = 20;
const FULL = 30;

/** Every internal role that works on cases. */
const CASE_WORKERS = [
  'TA_ASSESSOR',
  'TA_SPECIALIST',
  'TA_REVIEWER',
  'TA_APPROVER_L1',
  'TA_APPROVER_L2',
  'TA_APPROVER_L3',
  'TA_SUPERVISOR',
  'TA_OBJECTION_OFFICER',
  'TA_APPEALS_OFFICER',
  'TA_NOTICE_ISSUER',
];

const viewFor = (roles) => roles.map((role) => [role, VIEW]);
const editFor = (roles) => roles.map((role) => [role, EDIT]);

const PERMISSIONS = [
  // ------------------------------------------------------------- documents
  [
    'GET /api/v1/documents/:uuid',
    'ADMIN',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/documents/:uuid/url',
    'ADMIN',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    // Who read this taxpayer's evidence. Oversight roles only: it is an audit
    // record, not case working data.
    'GET /api/v1/documents/:uuid/access-history',
    'AUDIT_TRAIL',
    VIEW,
    [
      ['TA_SUPERVISOR', VIEW],
      ['TA_AUDITOR_READONLY', VIEW],
      ['TA_ADMIN', FULL],
    ],
  ],

  // ------------------------------------------------------------------ forms
  [
    'GET /api/v1/forms/templates',
    'ADMIN',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/forms/templates/:code/published',
    'ADMIN',
    VIEW,
    [
      ...viewFor(CASE_WORKERS),
      ['TA_TAXPAYER', VIEW],
      ['TA_AUDITOR_READONLY', VIEW],
      ['TA_ADMIN', FULL],
    ],
  ],
  ['POST /api/v1/forms/templates', 'ADMIN', FULL, [['TA_ADMIN', FULL]]],
  ['POST /api/v1/forms/templates/:id/publish', 'ADMIN', FULL, [['TA_ADMIN', FULL]]],
  ['POST /api/v1/forms/templates/:id/clone', 'ADMIN', FULL, [['TA_ADMIN', FULL]]],

  [
    'POST /api/v1/forms/submissions/draft',
    'ASSESSMENT_REGISTER',
    EDIT,
    [...editFor(CASE_WORKERS), ['TA_TAXPAYER', EDIT], ['TA_ADMIN', FULL]],
  ],
  [
    'POST /api/v1/forms/submissions',
    'ASSESSMENT_REGISTER',
    EDIT,
    [...editFor(CASE_WORKERS), ['TA_TAXPAYER', EDIT], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/forms/submissions/:uuid',
    'ASSESSMENT_REGISTER',
    VIEW,
    [
      ...viewFor(CASE_WORKERS),
      ['TA_TAXPAYER', VIEW],
      ['TA_AUDITOR_READONLY', VIEW],
      ['TA_ADMIN', FULL],
    ],
  ],
  [
    'GET /api/v1/forms/submissions/:uuid/revisions',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],

  // --------------------------------------------------------------- workflow
  [
    'GET /api/v1/workflow/tasks',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_TAXPAYER', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'POST /api/v1/workflow/tasks/:taskId/claim',
    'ASSESSMENT_REGISTER',
    EDIT,
    [...editFor(CASE_WORKERS), ['TA_ADMIN', FULL]],
  ],
  [
    'POST /api/v1/workflow/tasks/:taskId/complete',
    'ASSESSMENT_REGISTER',
    EDIT,
    [...editFor(CASE_WORKERS), ['TA_TAXPAYER', EDIT], ['TA_ADMIN', FULL]],
  ],
  // Repairing the read model is an operational act, not case work.
  ['POST /api/v1/workflow/reconcile', 'ADMIN', FULL, [['TA_ADMIN', FULL]]],

  // ------------------------------------------------------------------ admin
  [
    'GET /api/v1/admin/jobs',
    'ADMIN',
    VIEW,
    [
      ['TA_ADMIN', FULL],
      ['TA_AUDITOR_READONLY', VIEW],
    ],
  ],
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const stamp = { created_at: now, updated_at: now, is_active: true };

    const [menuRows] = await queryInterface.sequelize.query(
      'SELECT id, menu_code FROM platform.menu',
    );
    const menuId = new Map(menuRows.map((menu) => [menu.menu_code, menu.id]));

    const [roleRows] = await queryInterface.sequelize.query(
      'SELECT id, role_code FROM platform.role',
    );
    const roleId = new Map(roleRows.map((role) => [role.role_code, role.id]));

    await queryInterface.bulkInsert(
      { schema: 'platform', tableName: 'permission' },
      PERMISSIONS.map(([permission_key, menuCode, required_level]) => ({
        permission_key,
        menu_id: menuCode === null ? null : menuId.get(menuCode),
        required_level,
        ...stamp,
      })),
    );

    const [permissionRows] = await queryInterface.sequelize.query(
      'SELECT id, permission_key FROM platform.permission',
    );
    const permissionId = new Map(permissionRows.map((p) => [p.permission_key, p.id]));

    const grants = [];
    for (const [permissionKey, , , roleGrants] of PERMISSIONS) {
      for (const [roleCode, grantedLevel] of roleGrants) {
        const role = roleId.get(roleCode);
        if (role === undefined) {
          throw new Error(`Permission seed references unknown role '${roleCode}'`);
        }
        grants.push({
          role_id: role,
          permission_id: permissionId.get(permissionKey),
          granted_level: grantedLevel,
          ...stamp,
        });
      }
    }

    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'role_permission' }, grants);
  },

  async down(queryInterface, Sequelize) {
    const { Op } = Sequelize;
    const keys = PERMISSIONS.map(([key]) => key);

    const [permissionRows] = await queryInterface.sequelize.query(
      `SELECT id FROM platform.permission WHERE permission_key IN (:keys)`,
      { replacements: { keys } },
    );
    const ids = permissionRows.map((row) => row.id);

    if (ids.length > 0) {
      await queryInterface.bulkDelete(
        { schema: 'platform', tableName: 'role_permission' },
        { permission_id: { [Op.in]: ids } },
      );
    }
    await queryInterface.bulkDelete(
      { schema: 'platform', tableName: 'permission' },
      { permission_key: { [Op.in]: keys } },
    );
  },
};
