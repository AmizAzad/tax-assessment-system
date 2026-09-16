'use strict';

/**
 * Seed roles, menus and the permission catalogue.
 *
 * Plan reference: V2 sections 6.1, 9.2, 9.3.
 *
 * Authorisation fails closed: a route with no permission row is unreachable by
 * everyone. That makes this migration part of the security boundary rather
 * than convenience data, and it is why every new route must be registered in
 * the same migration that introduces it.
 *
 * Permission levels are hierarchical: 30 FULL implies 20 EDIT implies 10 VIEW.
 */

const VIEW = 10;
const EDIT = 20;
const FULL = 30;

const ROLES = [
  ['TA_TAXPAYER', 'Taxpayer', 'EXTERNAL'],
  ['TA_ASSESSOR', 'Tax Assessor', 'INTERNAL'],
  ['TA_SPECIALIST', 'Technical Specialist', 'INTERNAL'],
  ['TA_REVIEWER', 'Tax Reviewer', 'INTERNAL'],
  ['TA_APPROVER_L1', 'Approver Level 1', 'INTERNAL'],
  ['TA_APPROVER_L2', 'Approver Level 2', 'INTERNAL'],
  ['TA_APPROVER_L3', 'Approver Level 3', 'INTERNAL'],
  ['TA_SUPERVISOR', 'Supervisor', 'INTERNAL'],
  ['TA_OBJECTION_OFFICER', 'Objection Officer', 'INTERNAL'],
  ['TA_COMMITTEE_MEMBER', 'Committee Member', 'INTERNAL'],
  ['TA_APPEALS_OFFICER', 'Appeals Officer', 'INTERNAL'],
  ['TA_NOTICE_ISSUER', 'Notice Issuer', 'INTERNAL'],
  ['TA_AUDITOR_READONLY', 'Auditor (read-only)', 'INTERNAL'],
  ['TA_ADMIN', 'Administrator', 'INTERNAL'],
  ['SYSTEM', 'System service account', 'SYSTEM'],
];

const MENUS = [
  ['ASSESSMENT_REGISTER', 'ta.menu.assessmentRegister', '/assessments', 10],
  ['MY_ASSESSMENTS', 'ta.menu.myAssessments', '/assessments/mine', 20],
  ['REVIEW_QUEUE', 'ta.menu.reviewQueue', '/queues/review', 30],
  ['APPROVAL_QUEUE', 'ta.menu.approvalQueue', '/queues/approval', 40],
  ['NOTICES', 'ta.menu.notices', '/notices', 50],
  ['OBJECTIONS', 'ta.menu.objections', '/objections', 60],
  ['APPEALS', 'ta.menu.appeals', '/appeals', 70],
  ['DASHBOARD', 'ta.menu.dashboard', '/dashboard', 80],
  ['RULE_CONFIG', 'ta.menu.ruleConfiguration', '/admin/rule-sets', 90],
  ['ADMIN', 'ta.menu.administration', '/admin', 100],
  ['AUDIT_TRAIL', 'ta.menu.auditTrail', '/audit', 110],
];

/**
 * [permissionKey, menuCode, requiredLevel, [roleCode, grantedLevel]...]
 *
 * Only routes that exist today are listed. Later phases add their own rows in
 * the migration that introduces the route.
 */
const PERMISSIONS = [
  [
    'GET /api/v1/masters/:groupCode',
    'ADMIN',
    VIEW,
    [
      ['TA_ASSESSOR', VIEW],
      ['TA_REVIEWER', VIEW],
      ['TA_APPROVER_L1', VIEW],
      ['TA_APPROVER_L2', VIEW],
      ['TA_APPROVER_L3', VIEW],
      ['TA_SUPERVISOR', VIEW],
      ['TA_OBJECTION_OFFICER', VIEW],
      ['TA_APPEALS_OFFICER', VIEW],
      ['TA_AUDITOR_READONLY', VIEW],
      ['TA_ADMIN', FULL],
    ],
  ],
  [
    'GET /api/v1/masters',
    'ADMIN',
    VIEW,
    [
      ['TA_ADMIN', FULL],
      ['TA_AUDITOR_READONLY', VIEW],
    ],
  ],
  ['POST /api/v1/masters', 'ADMIN', EDIT, [['TA_ADMIN', FULL]]],
  [
    'GET /api/v1/me',
    null,
    VIEW,
    // Every authenticated role can read its own profile and effective
    // permissions. Without this the SPA cannot render a menu.
    ROLES.filter(([code]) => code !== 'SYSTEM').map(([code]) => [code, VIEW]),
  ],
  [
    'GET /api/v1/admin/permissions',
    'ADMIN',
    VIEW,
    [
      ['TA_ADMIN', FULL],
      ['TA_AUDITOR_READONLY', VIEW],
    ],
  ],
  ['POST /api/v1/admin/permissions/refresh-cache', 'ADMIN', FULL, [['TA_ADMIN', FULL]]],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const stamp = { created_at: now, updated_at: now, is_active: true };

    await queryInterface.bulkInsert(
      { schema: 'platform', tableName: 'role' },
      ROLES.map(([role_code, role_name, role_type]) => ({
        role_code,
        role_name,
        role_type,
        ...stamp,
      })),
    );

    await queryInterface.bulkInsert(
      { schema: 'platform', tableName: 'menu' },
      MENUS.map(([menu_code, display_key, route, sort_order]) => ({
        menu_code,
        display_key,
        route,
        sort_order,
        max_permission_level: FULL,
        ...stamp,
      })),
    );

    const [roleRows] = await queryInterface.sequelize.query(
      'SELECT id, role_code FROM platform.role',
    );
    const [menuRows] = await queryInterface.sequelize.query(
      'SELECT id, menu_code FROM platform.menu',
    );
    const roleId = new Map(roleRows.map((r) => [r.role_code, r.id]));
    const menuId = new Map(menuRows.map((m) => [m.menu_code, m.id]));

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
        grants.push({
          role_id: roleId.get(roleCode),
          permission_id: permissionId.get(permissionKey),
          granted_level: grantedLevel,
          ...stamp,
        });
      }
    }
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'role_permission' }, grants);

    // Display keys for the menus, so the SPA has something to render even
    // before the translation pass.
    await queryInterface.bulkInsert(
      { schema: 'platform', tableName: 'display_key' },
      MENUS.map(([, display_key]) => ({ key: display_key, ...stamp })),
    );

    const [keyRows] = await queryInterface.sequelize.query(
      `SELECT id, key FROM platform.display_key WHERE key LIKE 'ta.menu.%'`,
    );
    const keyId = new Map(keyRows.map((k) => [k.key, k.id]));

    const englishLabels = {
      'ta.menu.assessmentRegister': 'Assessment Register',
      'ta.menu.myAssessments': 'My Assessments',
      'ta.menu.reviewQueue': 'Review Queue',
      'ta.menu.approvalQueue': 'Approval Queue',
      'ta.menu.notices': 'Notices',
      'ta.menu.objections': 'Objections',
      'ta.menu.appeals': 'Appeals',
      'ta.menu.dashboard': 'Dashboard',
      'ta.menu.ruleConfiguration': 'Tax Rule Configuration',
      'ta.menu.administration': 'Administration',
      'ta.menu.auditTrail': 'Audit Trail',
    };

    await queryInterface.bulkInsert(
      { schema: 'platform', tableName: 'display_key_label' },
      Object.entries(englishLabels).map(([key, label]) => ({
        display_key_id: keyId.get(key),
        language_code: 'en',
        label,
        ...stamp,
      })),
    );
  },

  async down(queryInterface, Sequelize) {
    const { Op } = Sequelize;
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'role_permission' }, {});
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'permission' }, {});
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'display_key_label' }, {});
    await queryInterface.bulkDelete(
      { schema: 'platform', tableName: 'display_key' },
      { key: { [Op.like]: 'ta.menu.%' } },
    );
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'menu' }, {});
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'role' }, {});
  },
};
