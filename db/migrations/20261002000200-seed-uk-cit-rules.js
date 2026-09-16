'use strict';

/**
 * UK Corporation Tax rule set (FY2024) and the Phase 2-4 permissions.
 *
 * Plan reference: V2 sections 15.2, 15.3, 27.3; ADR-006, ADR-007.
 *
 * ## Provenance
 *
 * Rates and thresholds researched from published HMRC guidance. **Not signed
 * off by a qualified tax professional.** They are correct to the best of the
 * author's knowledge and are sufficient to demonstrate the engine end to end.
 * Before this computes a liability served on a real taxpayer, the rule set
 * needs review by someone qualified — that is a legal question rather than a
 * technical one.
 *
 * ## Monetary parameters are strings, never JSON numbers
 *
 * A JSON number is an IEEE double. A band boundary arriving as 49999.999999
 * would put a company in the wrong band, so every amount and rate below is a
 * decimal string (ADR-007).
 *
 * ## Seeded already PUBLISHED
 *
 * Dual control applies to a human publishing through the API. A migration is
 * not a person, and a demo environment with no computable rule set is useless.
 * Production promotion uses the export/import path with two people (plan 27.3).
 */

const VIEW = 10;
const EDIT = 20;
const FULL = 30;

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
];

const viewFor = (roles) => roles.map((role) => [role, VIEW]);
const editFor = (roles) => roles.map((role) => [role, EDIT]);

const PERMISSIONS = [
  [
    'POST /api/v1/cases',
    'ASSESSMENT_REGISTER',
    EDIT,
    [
      ['TA_ASSESSOR', EDIT],
      ['TA_SUPERVISOR', EDIT],
      ['TA_ADMIN', FULL],
    ],
  ],
  [
    'GET /api/v1/cases',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/cases/:id',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/cases/:id/timeline',
    'AUDIT_TRAIL',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    // One endpoint for every lifecycle action. The state machine decides what
    // each role may actually do, so the permission is coarse on purpose.
    'POST /api/v1/cases/:id/transition',
    'ASSESSMENT_REGISTER',
    EDIT,
    [...editFor(CASE_WORKERS), ['TA_ADMIN', FULL]],
  ],
  [
    'POST /api/v1/cases/:id/assign',
    'ASSESSMENT_REGISTER',
    EDIT,
    [
      ['TA_SUPERVISOR', EDIT],
      ['TA_ADMIN', FULL],
    ],
  ],
  [
    'GET /api/v1/cases/:id/adjustments',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'POST /api/v1/cases/:id/adjustments',
    'ASSESSMENT_REGISTER',
    EDIT,
    [
      ['TA_ASSESSOR', EDIT],
      ['TA_SPECIALIST', EDIT],
      ['TA_ADMIN', FULL],
    ],
  ],
  [
    'POST /api/v1/cases/:id/calculate',
    'ASSESSMENT_REGISTER',
    EDIT,
    [
      ['TA_ASSESSOR', EDIT],
      ['TA_SUPERVISOR', EDIT],
      ['TA_ADMIN', FULL],
    ],
  ],
  [
    'GET /api/v1/cases/:id/calculation',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/cases/:id/calculation/preview',
    'ASSESSMENT_REGISTER',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/cases/:id/calculation/history',
    'AUDIT_TRAIL',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  [
    'GET /api/v1/rule-sets',
    'RULE_CONFIG',
    VIEW,
    [...viewFor(CASE_WORKERS), ['TA_AUDITOR_READONLY', VIEW], ['TA_ADMIN', FULL]],
  ],
  // Publishing is TA_ADMIN and additionally requires author != publisher,
  // which the service enforces.
  ['POST /api/v1/rule-sets/:id/publish', 'RULE_CONFIG', FULL, [['TA_ADMIN', FULL]]],
];

const RULE_ITEMS = [
  {
    itemType: 'RATE_BAND',
    sequence: 1,
    descriptionKey: 'ta.rule.gb.cit.mainRate',
    parameters: {
      lowerBound: '50000',
      upperBound: '250000',
      rate: '0.25',
      // 3/200 exactly, written as a decimal string so it stays exact.
      marginalReliefFraction: '0.015',
    },
  },
  {
    itemType: 'RATE_BAND',
    sequence: 2,
    descriptionKey: 'ta.rule.gb.cit.smallProfitsRate',
    parameters: {
      lowerBound: '0',
      upperBound: '50000',
      rate: '0.19',
      smallProfitsRate: '0.19',
    },
  },
  {
    itemType: 'LOSS_RULE',
    sequence: 1,
    descriptionKey: 'ta.rule.gb.cit.lossCarryForward',
    parameters: { setOffOrder: 'OLDEST_FIRST' },
  },
  {
    itemType: 'CREDIT_ORDER',
    sequence: 1,
    descriptionKey: 'ta.rule.gb.cit.creditOrder',
    // Non-refundable first, so a refundable credit is not wasted.
    parameters: { order: ['DOUBLE_TAX_RELIEF', 'WITHHOLDING_TAX', 'ADVANCE_PAYMENT'] },
  },
  {
    itemType: 'PENALTY',
    sequence: 1,
    descriptionKey: 'ta.rule.gb.cit.penalty.day1',
    parameters: { trigger: 'FILING', appliesAfterDays: 0, basis: 'FIXED', fixedAmount: '100' },
  },
  {
    itemType: 'PENALTY',
    sequence: 2,
    descriptionKey: 'ta.rule.gb.cit.penalty.month3',
    parameters: { trigger: 'FILING', appliesAfterDays: 90, basis: 'FIXED', fixedAmount: '100' },
  },
  {
    itemType: 'PENALTY',
    sequence: 3,
    descriptionKey: 'ta.rule.gb.cit.penalty.month6',
    parameters: { trigger: 'FILING', appliesAfterDays: 180, basis: 'PERCENT', percentRate: '0.10' },
  },
  {
    itemType: 'INTEREST',
    sequence: 1,
    descriptionKey: 'ta.rule.gb.cit.interest.latePayment',
    parameters: {
      // HMRC late-payment interest is base rate plus 2.5%. A rate that moves
      // belongs in an effective-dated rule set, which is what this is.
      annualRate: '0.0775',
      dayCount: 365,
      compounding: 'SIMPLE',
      graceDays: 0,
    },
  },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const stamp = { created_at: now, updated_at: now, is_active: true };

    // ------------------------------------------------------------ rule set
    await queryInterface.bulkInsert({ schema: 'tax', tableName: 'tax_rule_set' }, [
      {
        code: 'GB-CIT-FY2024',
        jurisdiction_code: 'GB',
        tax_type_code: 'CIT',
        version: 1,
        status: 'PUBLISHED',
        effective_from: '2023-04-01',
        effective_to: null,
        currency_code: 'GBP',
        rounding_scale: 0,
        rounding_mode: 'HALF_UP',
        published_at: now,
        notes:
          'Researched from published HMRC guidance. Requires review by a qualified tax ' +
          'professional before use on a real assessment.',
        ...stamp,
      },
    ]);

    const [ruleSets] = await queryInterface.sequelize.query(
      `SELECT id FROM tax.tax_rule_set WHERE code = 'GB-CIT-FY2024'`,
    );
    const ruleSetId = ruleSets[0].id;

    await queryInterface.bulkInsert(
      { schema: 'tax', tableName: 'tax_rule_set_item' },
      RULE_ITEMS.map((item) => ({
        rule_set_id: ruleSetId,
        item_type: item.itemType,
        sequence: item.sequence,
        parameters_json: JSON.stringify(item.parameters),
        description_key: item.descriptionKey,
        ...stamp,
      })),
    );

    // ---------------------------------------------------------- deadlines
    await queryInterface.bulkInsert({ schema: 'tax', tableName: 'tax_deadline_config' }, [
      {
        jurisdiction_code: 'GB',
        tax_type_code: 'CIT',
        deadline_type: 'OBJECTION',
        // The clock runs from service, not from finalisation (plan 8.2 stage 8).
        anchor_event: 'NOTICE_SERVED',
        offset_value: 30,
        offset_unit: 'DAYS',
        calendar_rule: 'CALENDAR_DAYS',
        ...stamp,
      },
      {
        jurisdiction_code: 'GB',
        tax_type_code: 'CIT',
        deadline_type: 'RESPONSE',
        anchor_event: 'INFO_REQUESTED',
        offset_value: 30,
        offset_unit: 'DAYS',
        calendar_rule: 'CALENDAR_DAYS',
        ...stamp,
      },
      {
        jurisdiction_code: 'GB',
        tax_type_code: 'CIT',
        deadline_type: 'APPEAL',
        anchor_event: 'OBJECTION_DECIDED',
        offset_value: 30,
        offset_unit: 'DAYS',
        calendar_rule: 'CALENDAR_DAYS',
        ...stamp,
      },
    ]);

    // -------------------------------------------------------- permissions
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
        menu_id: menuId.get(menuCode) ?? null,
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

    await queryInterface.bulkDelete({ schema: 'tax', tableName: 'tax_deadline_config' }, {});
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_rule_set_item WHERE rule_set_id IN
         (SELECT id FROM tax.tax_rule_set WHERE code = 'GB-CIT-FY2024')`,
    );
    await queryInterface.bulkDelete(
      { schema: 'tax', tableName: 'tax_rule_set' },
      { code: 'GB-CIT-FY2024' },
    );
  },
};
