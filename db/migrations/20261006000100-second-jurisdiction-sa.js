'use strict';

/**
 * A second jurisdiction, configured end to end with no code change.
 *
 * Plan reference: V2 sections 7.3, 23 and the Phase 8 acceptance test.
 *
 * ## What this migration is for
 *
 * The plan makes one large claim about this platform: adding a jurisdiction
 * should be rule sets, deadline configuration, templates, master data and
 * display keys, and **zero lines of code**. This file is the test of that
 * claim. If anything here had required a new branch in a service, the claim
 * was false and the design needed changing rather than the data.
 *
 * Saudi Arabia was chosen deliberately, because it differs from the United
 * Kingdom in the ways most likely to expose a hard-coded assumption:
 *
 * | | GB | SA |
 * |---|---|---|
 * | Weekend | Saturday, Sunday | **Friday, Saturday** |
 * | Currency | GBP | **SAR** |
 * | Rate shape | Two bands with marginal relief | **Flat 20%, no relief** |
 * | Filing deadline | 12 months after period end | **120 days after period end** |
 * | Payment deadline | 9 months and 1 day | **Same as filing** |
 * | Objection window | 30 days | **60 days** |
 * | Late filing penalty | Fixed, then percentage | **Percentage of tax, capped** |
 * | Appeal forums | Tribunals and courts | **Committees** |
 *
 * The Friday-Saturday weekend is the sharpest of these: a platform that
 * assumed the western working week would compute every SA deadline wrongly,
 * and nothing in the arithmetic would look broken.
 *
 * ## Accuracy
 *
 * These figures are illustrative and structurally faithful rather than
 * certified. They carry the same SME sign-off caveat as the UK seed. The point
 * being demonstrated is the shape of the configuration, not tax advice.
 */
module.exports = {
  async up(queryInterface) {
    // ---------------------------------------------------------------- basics

    await queryInterface.sequelize.query(`
      INSERT INTO platform.currency (currency_code, display_key, decimal_places, symbol, created_at, updated_at, is_active)
      VALUES ('SAR', 'ta.currency.sar', 2, 'SR', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    /**
     * Friday and Saturday.
     *
     * The single most important row in this file. Everything that counts
     * working days -- deemed service, business-day deadlines -- reads it.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.master_data (group_code, jurisdiction_code, display_key, description, created_at, updated_at, is_active)
      SELECT 'WEEKEND_DAYS', 'SA', 'ta.masters.weekendDays', 'Days that are not working days', now(), now(), true
       WHERE NOT EXISTS (SELECT 1 FROM platform.master_data
                          WHERE group_code = 'WEEKEND_DAYS' AND jurisdiction_code = 'SA')
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.master_data_item (master_data_id, item_code, display_key, sort_order, created_at, updated_at, is_active)
      SELECT d.id, v.code, 'ta.day.' || lower(v.code), v.ord, now(), now(), true
        FROM platform.master_data d
        CROSS JOIN (VALUES ('FRI', 1), ('SAT', 2)) AS v(code, ord)
       WHERE d.group_code = 'WEEKEND_DAYS' AND d.jurisdiction_code = 'SA'
         AND NOT EXISTS (SELECT 1 FROM platform.master_data_item i
                          WHERE i.master_data_id = d.id AND i.item_code = v.code)
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.holiday (jurisdiction_code, holiday_date, display_key, created_at, updated_at, is_active)
      VALUES
        ('SA', '2026-09-23', 'ta.holiday.nationalDay', now(), now(), true),
        ('SA', '2027-03-20', 'ta.holiday.eidAlFitr', now(), now(), true),
        ('SA', '2027-03-21', 'ta.holiday.eidAlFitrHoliday', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // ------------------------------------------------------------ master data

    /**
     * The dispute vocabulary, which is not the UK's.
     *
     * Appeals in Saudi Arabia go to committees rather than tribunals. A
     * hard-coded forum list would have made this impossible without a release.
     */
    for (const [group, items] of [
      [
        'APPEAL_FORUM',
        [
          ['GENERAL_SECRETARIAT', 1],
          ['APPELLATE_COMMITTEE', 2],
          ['SUPREME_ADMINISTRATIVE_COURT', 3],
        ],
      ],
      [
        'OBJECTION_GROUND',
        [
          ['ASSESSMENT_BASIS_DISPUTED', 1],
          ['DOCUMENTS_NOT_CONSIDERED', 2],
          ['CALCULATION_ERROR', 3],
          ['PENALTY_EXCESSIVE', 4],
        ],
      ],
      [
        'CLOSURE_REASON',
        [
          ['SETTLED_IN_FULL', 1],
          ['DISPUTE_EXHAUSTED', 2],
          ['TIME_BARRED', 3],
          ['WRITTEN_OFF', 4],
        ],
      ],
      [
        'ADJUSTMENT_REASON',
        [
          ['UNSUPPORTED_EXPENSE', 1],
          ['RELATED_PARTY_PRICING', 2],
          ['UNDECLARED_REVENUE', 3],
        ],
      ],
      [
        'RETENTION_CLASS',
        [
          ['STATUTORY', 1],
          ['EXTENDED', 2],
          ['PERMANENT', 3],
        ],
      ],
    ]) {
      await queryInterface.sequelize.query(
        `INSERT INTO platform.master_data (group_code, jurisdiction_code, display_key, created_at, updated_at, is_active)
         SELECT :group, 'SA', 'ta.masters.' || lower(:group), now(), now(), true
          WHERE NOT EXISTS (SELECT 1 FROM platform.master_data
                             WHERE group_code = :group AND jurisdiction_code = 'SA')`,
        { replacements: { group } },
      );

      for (const [code, order] of items) {
        await queryInterface.sequelize.query(
          `INSERT INTO platform.master_data_item (master_data_id, item_code, display_key, sort_order, attributes_json, created_at, updated_at, is_active)
           SELECT d.id, :code, 'ta.item.' || lower(:code), :order,
                  CASE WHEN :group = 'RETENTION_CLASS'
                       THEN jsonb_build_object('retainYears',
                              CASE :code WHEN 'STATUTORY' THEN 10 WHEN 'EXTENDED' THEN 20 ELSE 0 END)
                       ELSE '{}'::jsonb END,
                  now(), now(), true
             FROM platform.master_data d
            WHERE d.group_code = :group AND d.jurisdiction_code = 'SA'
              AND NOT EXISTS (SELECT 1 FROM platform.master_data_item i
                               WHERE i.master_data_id = d.id AND i.item_code = :code)`,
          { replacements: { group, code, order } },
        );
      }
    }

    // ------------------------------------------------------------- deadlines

    /**
     * Deadlines, in working days where the statute counts working days.
     *
     * `BUSINESS_DAYS` here is what makes the Friday-Saturday weekend bite: an
     * objection window of 60 working days lands on a different date than it
     * would in the United Kingdom, from the same start.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_deadline_config
        (jurisdiction_code, tax_type_code, deadline_type, anchor_event,
         offset_value, offset_unit, calendar_rule,
         secondary_offset_value, secondary_offset_unit, effective_from,
         created_at, updated_at, is_active)
      VALUES
        ('SA', 'CIT', 'FILING',    'PERIOD_END',       120, 'DAYS',  'NEXT_BUSINESS_DAY', NULL, NULL, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'PAYMENT',   'PERIOD_END',       120, 'DAYS',  'NEXT_BUSINESS_DAY', NULL, NULL, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'OBJECTION', 'NOTICE_SERVED',     60, 'DAYS',  'NEXT_BUSINESS_DAY', NULL, NULL, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'APPEAL',    'OBJECTION_DECIDED', 30, 'DAYS',  'NEXT_BUSINESS_DAY', NULL, NULL, '2024-01-01', now(), now(), true),
        ('SA', 'CIT', 'RESPONSE',  'INFO_REQUESTED',    20, 'DAYS',  'BUSINESS_DAYS',     NULL, NULL, '2024-01-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // --------------------------------------------------------- service rules

    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_service_rule
        (jurisdiction_code, channel, deemed_after_value, deemed_after_unit, calendar_rule,
         actual_delivery_wins, effective_from, created_at, updated_at, is_active)
      VALUES
        ('SA', 'EMAIL',           0, 'DAYS', 'CALENDAR_DAYS', true,  '2024-01-01', now(), now(), true),
        ('SA', 'PORTAL',          0, 'DAYS', 'CALENDAR_DAYS', true,  '2024-01-01', now(), now(), true),
        ('SA', 'SMS',             0, 'DAYS', 'CALENDAR_DAYS', true,  '2024-01-01', now(), now(), true),
        ('SA', 'HAND_DELIVERY',   0, 'DAYS', 'CALENDAR_DAYS', true,  '2024-01-01', now(), now(), true),
        ('SA', 'REGISTERED_POST', 5, 'DAYS', 'BUSINESS_DAYS', true,  '2024-01-01', now(), now(), true),
        ('SA', 'PUBLICATION',    14, 'DAYS', 'CALENDAR_DAYS', false, '2024-01-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // ------------------------------------------------------------- rule set

    /**
     * A flat rate with no marginal relief.
     *
     * Expressed as a single band from zero with no upper bound and no
     * `marginalReliefFraction`. The same `applyProgressiveBands` step handles
     * it; nothing in the pipeline needed a flag for "this jurisdiction is
     * flat".
     *
     * The penalty is a percentage of tax with a cap, which exercises a rule
     * shape the UK seed does not use.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_rule_set
        (code, jurisdiction_code, tax_type_code, version, status,
         effective_from, effective_to, currency_code, rounding_scale, rounding_mode,
         notes, created_at, updated_at, is_active)
      VALUES
        ('SA-CIT-2024', 'SA', 'CIT', 1, 'PUBLISHED',
         '2024-01-01', NULL, 'SAR', 0, 'HALF_UP',
         'Illustrative Saudi corporate income tax configuration. Flat rate, no marginal relief. Not certified; see the migration header.',
         now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_rule_set_item
        (rule_set_id, item_type, sequence, parameters_json, description_key, created_at, updated_at, is_active)
      SELECT s.id, v.item_type, v.seq, v.params::jsonb, v.key, now(), now(), true
        FROM tax.tax_rule_set s
        CROSS JOIN (VALUES
          ('RATE_BAND',    1, '{"rate": "0.20", "lowerBound": "0"}',                                          'ta.rule.sa.flatRate'),
          ('LOSS_RULE',    1, '{"setOffOrder": "OLDEST_FIRST"}',                                              'ta.rule.sa.lossSetOff'),
          ('CREDIT_ORDER', 1, '{"order": ["WITHHOLDING_TAX", "ADVANCE_PAYMENT", "DOUBLE_TAX_RELIEF"]}',       'ta.rule.sa.creditOrder'),
          ('PENALTY',      1, '{"basis": "PERCENT", "trigger": "FILING", "percentRate": "0.01", "appliesAfterDays": 0, "cap": "100000"}', 'ta.rule.sa.lateFiling'),
          ('PENALTY',      2, '{"basis": "PERCENT", "trigger": "PAYMENT", "percentRate": "0.05", "appliesAfterDays": 30, "cap": "250000"}', 'ta.rule.sa.latePayment'),
          ('INTEREST',     1, '{"annualRate": "0.05", "dayCount": 360, "compounding": "SIMPLE", "graceDays": 0}', 'ta.rule.sa.interest')
        ) AS v(item_type, seq, params, key)
       WHERE s.code = 'SA-CIT-2024'
         AND NOT EXISTS (SELECT 1 FROM tax.tax_rule_set_item i
                          WHERE i.rule_set_id = s.id AND i.item_type = v.item_type AND i.sequence = v.seq)
    `);

    // -------------------------------------------------------- approval bands

    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_approval_threshold
        (jurisdiction_code, tax_type_code, amount_from, amount_to, currency_code,
         required_role_code, required_approvals, created_at, updated_at, is_active)
      VALUES
        ('SA', 'CIT',        0.0000,   500000.0000, 'SAR', 'TA_APPROVER_L1', 1, now(), now(), true),
        ('SA', 'CIT',   500000.0000,  5000000.0000, 'SAR', 'TA_APPROVER_L2', 1, now(), now(), true),
        ('SA', 'CIT',  5000000.0000,          NULL, 'SAR', 'TA_APPROVER_L3', 2, now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    // ------------------------------------------------------ notice templates

    const assessmentBody = [
      '{{taxpayerName}}',
      '',
      'ASSESSMENT OF {{taxType}} FOR THE PERIOD {{assessmentYear}}',
      '',
      'Taxpayer identification number: {{tin}}',
      'Case reference: {{caseNumber}}',
      'Date of issue: {{issueDate}}',
      '',
      'An assessment has been raised in respect of the period shown above.',
      '',
      'Amount chargeable: {{currency}} {{taxableBase}}',
      'Tax charged at the prescribed rate: {{currency}} {{taxBeforeCredits}}',
      'Less credits: {{currency}} {{totalCredits}}',
      'Penalty: {{currency}} {{penaltyAmount}}',
      'Delay fine: {{currency}} {{interestAmount}}',
      '',
      'AMOUNT NOW PAYABLE: {{currency}} {{netPayable}}',
      '',
      'Payment fell due on {{paymentDueDate}}.',
      '',
      'OBJECTION',
      '',
      'You may object to this assessment in writing within the period prescribed by law,',
      'counted from the date this notice is treated as served on you. An objection must state',
      'the grounds relied upon.',
      '',
      'Tax Assessment Authority',
      '{{jurisdiction}}',
    ].join('\n');

    await queryInterface.sequelize.query(
      `INSERT INTO tax.tax_notice_template
              (jurisdiction_code, tax_type_code, notice_type, language_code, version,
               title_template, body_template, required_tokens, status, effective_from,
               created_at, updated_at, is_active)
       VALUES ('SA', 'CIT', 'ASSESSMENT', 'en', 1,
               'Notice of Assessment - {{taxType}} {{assessmentYear}}', :assessmentBody,
               '[]'::jsonb, 'PUBLISHED', '2024-01-01', now(), now(), true)
       ON CONFLICT DO NOTHING`,
      { replacements: { assessmentBody } },
    );

    // --------------------------------------------------------- a demo filer

    await queryInterface.sequelize.query(`
      INSERT INTO platform.taxpayer
        (tin, name, taxpayer_kind, jurisdiction_code, status, registration_date,
         preferred_language, created_at, updated_at, is_active)
      SELECT '3001122334', 'Najd Industrial Co.', 'COMPANY', 'SA', 'ACTIVE', '2019-06-01',
             'en', now(), now(), true
       WHERE NOT EXISTS (SELECT 1 FROM platform.taxpayer WHERE tin = '3001122334')
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM platform.taxpayer WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_notice_template WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_approval_threshold WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(`
      DELETE FROM tax.tax_rule_set_item WHERE rule_set_id IN
        (SELECT id FROM tax.tax_rule_set WHERE jurisdiction_code = 'SA')
    `);
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_rule_set WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_service_rule WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_deadline_config WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM platform.holiday WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(`
      DELETE FROM platform.master_data_item WHERE master_data_id IN
        (SELECT id FROM platform.master_data WHERE jurisdiction_code = 'SA')
    `);
    await queryInterface.sequelize.query(
      `DELETE FROM platform.master_data WHERE jurisdiction_code = 'SA'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM platform.currency WHERE currency_code = 'SAR'`,
    );
  },
};
