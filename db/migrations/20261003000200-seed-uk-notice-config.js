'use strict';

/**
 * UK notice wording, service rules and the objection window.
 *
 * Plan reference: V2 sections 12.2 to 12.6.
 *
 * ## The wording is illustrative
 *
 * A real assessment notice carries statutory wording settled by the revenue
 * authority's lawyers, including the precise formulation of appeal rights. The
 * text below is plausible and structurally complete but has **not** been
 * through legal sign-off. It is seeded as configuration precisely so that
 * replacing it is an administrative act rather than a deployment.
 *
 * ## Deemed service
 *
 * Electronic channels are treated as served on the day of despatch. Post is
 * deemed served two working days later, which is the common shape in UK
 * practice. Both run through the deadline engine's working calendar, so a
 * letter posted on the Friday before a bank holiday is not deemed served over
 * the weekend.
 */
module.exports = {
  async up(queryInterface) {
    const assessmentBody = [
      'Dear {{taxpayerName}},',
      '',
      'ASSESSMENT OF {{taxType}} FOR THE PERIOD {{assessmentYear}}',
      '',
      'Taxpayer identification number: {{tin}}',
      'Case reference: {{caseNumber}}',
      'Date of issue: {{issueDate}}',
      '',
      'Following an examination of your affairs for the period shown above, an assessment has',
      'been made. The basis of the assessment is set out below.',
      '',
      'Amount declared: {{currency}} {{declaredBase}}',
      'Adjustments: {{currency}} {{totalAdjustments}}',
      'Assessed amount: {{currency}} {{assessedBase}}',
      'Losses set off: {{currency}} {{lossesSetOff}}',
      'Amount chargeable: {{currency}} {{taxableBase}}',
      '',
      'Tax charged: {{currency}} {{taxBeforeCredits}}',
      'Less credits: {{currency}} {{totalCredits}}',
      'Tax after credits: {{currency}} {{taxAfterCredits}}',
      'Penalty: {{currency}} {{penaltyAmount}}',
      'Interest: {{currency}} {{interestAmount}}',
      '',
      'AMOUNT NOW PAYABLE: {{currency}} {{netPayable}}',
      '',
      'Payment was due on {{paymentDueDate}}. Interest continues to accrue on any amount that',
      'remains unpaid.',
      '',
      'YOUR RIGHT TO OBJECT',
      '',
      'If you disagree with this assessment you may object in writing. An objection must state',
      'the grounds on which it is made and must reach us within the period allowed by law,',
      'calculated from the date this notice is treated as served on you.',
      '',
      'Yours faithfully,',
      '',
      'Tax Assessment Authority',
      '{{jurisdiction}}',
    ].join('\n');

    const demandBody = [
      'Dear {{taxpayerName}},',
      '',
      'DEMAND FOR PAYMENT - {{taxType}} {{assessmentYear}}',
      '',
      'Taxpayer identification number: {{tin}}',
      'Case reference: {{caseNumber}}',
      'Date of issue: {{issueDate}}',
      '',
      'Our records show that {{currency}} {{netPayable}} remains payable in respect of the',
      'assessment for the period shown above. Payment was due on {{paymentDueDate}}.',
      '',
      'Please pay the amount outstanding without further delay. If you have already paid, or if',
      'you believe this demand is mistaken, contact us immediately quoting the case reference.',
      '',
      'Yours faithfully,',
      '',
      'Tax Assessment Authority',
      '{{jurisdiction}}',
    ].join('\n');

    // `required_tokens` is filled by the publish check rather than by hand, so
    // it cannot drift from the wording.
    await queryInterface.sequelize.query(
      `INSERT INTO tax.tax_notice_template
              (jurisdiction_code, tax_type_code, notice_type, language_code, version,
               title_template, body_template, required_tokens, status, effective_from,
               created_at, updated_at, is_active)
       VALUES
         ('GB', 'CIT', 'ASSESSMENT', 'en', 1,
          'Notice of Assessment - {{taxType}} {{assessmentYear}}', :assessmentBody,
          '[]'::jsonb, 'PUBLISHED', '2023-04-01', now(), now(), true),
         ('GB', 'CIT', 'DEMAND', 'en', 1,
          'Demand for Payment - {{taxType}} {{assessmentYear}}', :demandBody,
          '[]'::jsonb, 'PUBLISHED', '2023-04-01', now(), now(), true)
       ON CONFLICT DO NOTHING`,
      { replacements: { assessmentBody, demandBody } },
    );

    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_service_rule
        (jurisdiction_code, channel, deemed_after_value, deemed_after_unit, calendar_rule,
         actual_delivery_wins, effective_from, created_at, updated_at, is_active)
      VALUES
        ('GB', 'EMAIL',           0, 'DAYS', 'CALENDAR_DAYS', true,  '2023-04-01', now(), now(), true),
        ('GB', 'PORTAL',          0, 'DAYS', 'CALENDAR_DAYS', true,  '2023-04-01', now(), now(), true),
        ('GB', 'SMS',             0, 'DAYS', 'CALENDAR_DAYS', true,  '2023-04-01', now(), now(), true),
        ('GB', 'HAND_DELIVERY',   0, 'DAYS', 'CALENDAR_DAYS', true,  '2023-04-01', now(), now(), true),
        ('GB', 'REGISTERED_POST', 2, 'DAYS', 'BUSINESS_DAYS', true,  '2023-04-01', now(), now(), true),
        ('GB', 'PUBLICATION',     7, 'DAYS', 'CALENDAR_DAYS', false, '2023-04-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    /**
     * The objection window, anchored on service.
     *
     * The pre-existing OBJECTION row is anchored on NOTICE_SERVED already, but
     * counts plain calendar days. Switching it to roll off a weekend is the
     * taxpayer-favourable reading and matches how these windows are applied in
     * practice: an objection due on a Sunday is in time on the Monday.
     */
    await queryInterface.sequelize.query(`
      UPDATE tax.tax_deadline_config
         SET calendar_rule = 'NEXT_BUSINESS_DAY', updated_at = now()
       WHERE jurisdiction_code = 'GB'
         AND tax_type_code = 'CIT'
         AND deadline_type IN ('OBJECTION', 'APPEAL', 'RESPONSE')
    `);

    /**
     * Weekend configuration for the demonstration jurisdiction.
     *
     * Explicit even though it matches the default, so that the mechanism a
     * second jurisdiction will use is exercised rather than merely available.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO platform.master_data (group_code, jurisdiction_code, display_key, description, created_at, updated_at, is_active)
      SELECT 'WEEKEND_DAYS', 'GB', 'ta.masters.weekendDays', 'Days that are not working days', now(), now(), true
       WHERE NOT EXISTS (
         SELECT 1 FROM platform.master_data
          WHERE group_code = 'WEEKEND_DAYS' AND jurisdiction_code = 'GB')
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.master_data_item (master_data_id, item_code, display_key, sort_order, created_at, updated_at, is_active)
      SELECT d.id, v.code, 'ta.day.' || lower(v.code), v.ord, now(), now(), true
        FROM platform.master_data d
        CROSS JOIN (VALUES ('SAT', 1), ('SUN', 2)) AS v(code, ord)
       WHERE d.group_code = 'WEEKEND_DAYS' AND d.jurisdiction_code = 'GB'
         AND NOT EXISTS (
           SELECT 1 FROM platform.master_data_item i
            WHERE i.master_data_id = d.id AND i.item_code = v.code)
    `);

    // Notification types used by the notice and deadline paths. Without a row
    // here the send is refused, which would make a served notice look failed.
    await queryInterface.sequelize.query(`
      INSERT INTO platform.notification_type (type_code, display_key, description, default_channels, is_mandatory, created_at, updated_at, is_active)
      VALUES
        ('NOTICE_SERVED',        'ta.notification.noticeServed',       'A notice has been served', '["EMAIL"]'::jsonb, true,  now(), now(), true),
        ('DEADLINE_APPROACHING', 'ta.notification.deadlineApproaching','A statutory deadline is near', '["EMAIL"]'::jsonb, false, now(), now(), true),
        ('DEADLINE_BREACHED',    'ta.notification.deadlineBreached',   'A statutory deadline has passed', '["EMAIL"]'::jsonb, false, now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.permission (permission_key, menu_id, required_level, description, created_at, updated_at, is_active)
      VALUES ('GET /api/v1/cases/:id/deadlines/recorded', 1, 10, 'Deadlines running on a case', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO platform.role_permission (role_id, permission_id, granted_level, created_at, updated_at, is_active)
      SELECT r.id, p.id, 10, now(), now(), true
        FROM platform.role r
        JOIN platform.permission p ON p.permission_key = 'GET /api/v1/cases/:id/deadlines/recorded'
       WHERE r.role_type = 'INTERNAL'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM platform.notification_type WHERE type_code IN
         ('NOTICE_SERVED','DEADLINE_APPROACHING','DEADLINE_BREACHED')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM platform.master_data_item WHERE master_data_id IN
         (SELECT id FROM platform.master_data WHERE group_code = 'WEEKEND_DAYS')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM platform.master_data WHERE group_code = 'WEEKEND_DAYS'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_service_rule WHERE jurisdiction_code = 'GB'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.tax_notice_template WHERE jurisdiction_code = 'GB'`,
    );
  },
};
