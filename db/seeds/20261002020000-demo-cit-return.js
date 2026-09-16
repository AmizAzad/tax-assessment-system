'use strict';

/**
 * A demo corporation tax return: the form template, and one filed submission.
 *
 * Plan reference: V2 sections 8.4, 12.2.
 *
 * ## What this exists to demonstrate
 *
 * The filing evidence provider maps a submission to tax concepts by reading
 * `taxConcept` off the template's elements. That indirection is the whole
 * point of a configuration-driven platform, and it is invisible until there is
 * a template that uses it. This seed provides one.
 *
 * ## Why the amounts are strings
 *
 * `"850000.00"`, not `850000.00`. The submission JSON is the last place a
 * figure exists before it becomes an assessment, and a JSON number would have
 * already lost exactness by the time anything server-side could object
 * (ADR-007). The filing provider warns when it meets a number here, so this
 * seed also serves as the example of the correct shape.
 *
 * Seed data, not migration data: this is a demonstration company, and a
 * deployment that does not want it simply does not run the seeds.
 */
module.exports = {
  async up(queryInterface) {
    // fieldType is the numeric FieldType enum, not a name: that is what the
    // renderer and the core engines switch on. A readable string here would
    // publish a template no renderer can display.
    const definition = {
      schemaVersion: '1.0',
      root: [
        {
          uuid: 'e2a1f000-0000-4000-8000-000000000001',
          jsonKey: 'tradingSection',
          fieldType: 4, // FieldType.SECTION
          displayKey: 'cit.section.trading',
          children: [
            {
              uuid: 'e2a1f000-0000-4000-8000-000000000002',
              jsonKey: 'turnover',
              fieldType: 11, // FieldType.NUMBER
              displayKey: 'cit.field.turnover',
              currency: 'GBP',
              required: true,
            },
            {
              uuid: 'e2a1f000-0000-4000-8000-000000000003',
              jsonKey: 'tradingProfit',
              fieldType: 11, // FieldType.NUMBER
              displayKey: 'cit.field.tradingProfit',
              currency: 'GBP',
              required: true,
              // The mapping the filing provider reads. Turnover deliberately
              // carries none: it is context for a caseworker, not a figure
              // that enters the assessment base.
              taxConcept: 'TRADING_PROFIT',
            },
          ],
        },
        {
          uuid: 'e2a1f000-0000-4000-8000-000000000004',
          jsonKey: 'otherIncomeSection',
          fieldType: 4, // FieldType.SECTION
          displayKey: 'cit.section.otherIncome',
          children: [
            {
              uuid: 'e2a1f000-0000-4000-8000-000000000005',
              jsonKey: 'interestReceived',
              fieldType: 11, // FieldType.NUMBER
              displayKey: 'cit.field.interestReceived',
              currency: 'GBP',
              taxConcept: 'INTEREST_RECEIVED',
            },
            {
              uuid: 'e2a1f000-0000-4000-8000-000000000006',
              jsonKey: 'propertyIncome',
              fieldType: 11, // FieldType.NUMBER
              displayKey: 'cit.field.propertyIncome',
              currency: 'GBP',
              taxConcept: 'PROPERTY_INCOME',
            },
          ],
        },
      ],
    };

    // template_code starts with the tax type because the filing provider finds
    // a return by `template_code LIKE 'CIT-%'` for the case's tax type.
    await queryInterface.sequelize.query(
      `INSERT INTO forms.form_template
              (uuid, category_id, template_code, version, display_key, definition, schema_version,
               status, applies_to_year, is_login_required,
               published_at, created_at, updated_at, is_active)
       SELECT gen_random_uuid(), c.id, 'CIT-RETURN-GB', 1, 'cit.return.title', :definition, '1.0',
              'PUBLISHED', '2024', true,
              now(), now(), now(), true
         FROM forms.form_category c
        WHERE c.category_code = 'TAX-CIT'
          AND NOT EXISTS (
            SELECT 1 FROM forms.form_template t
             WHERE t.template_code = 'CIT-RETURN-GB' AND t.applies_to_year = '2024')`,
      { replacements: { definition: JSON.stringify(definition) } },
    );

    /**
     * The filed return.
     *
     * Filed 2026-02-10 against a period ending 2024-12-31. The UK filing
     * deadline is twelve months after the period end, so this return is late,
     * which is deliberate: it exercises the late-filing penalty step rather
     * than leaving it untested at zero.
     */
    await queryInterface.sequelize.query(
      `INSERT INTO forms.form_template_data
              (uuid, form_template_id, json, status, reference_number,
               context_type, context_id, submitted_at,
               created_at, updated_at, is_active)
       SELECT gen_random_uuid(), t.id, :values, 'SUBMITTED', 'CIT-2024-000001',
              'TAXPAYER', p.id, '2026-02-10T00:00:00Z',
              now(), now(), true
         FROM forms.form_template t
         CROSS JOIN platform.taxpayer p
        WHERE t.template_code = 'CIT-RETURN-GB'
          AND t.applies_to_year = '2024'
          AND p.tin = '1234567890'
          AND NOT EXISTS (
            SELECT 1 FROM forms.form_template_data d
             WHERE d.reference_number = 'CIT-2024-000001')`,
      {
        replacements: {
          values: JSON.stringify({
            turnover: '2400000.00',
            tradingProfit: '180000.00',
            interestReceived: '12500.00',
            propertyIncome: '7500.00',
          }),
        },
      },
    );

    /**
     * A part payment and a withholding credit.
     *
     * Without these the credits and payment steps of the pipeline never run on
     * real data, and a step that has only ever executed against zero is a step
     * nobody has tested.
     */
    await queryInterface.sequelize.query(`
      INSERT INTO tax.taxpayer_account_entry
              (taxpayer_id, tax_type_code, assessment_year, entry_type, credit_code,
               amount, currency_code, is_non_refundable, value_date,
               source_system, source_reference, narrative,
               created_at, updated_at, is_active)
      SELECT p.id, 'CIT', '2024', 'PAYMENT', NULL,
             25000.0000, 'GBP', false, '2025-10-01',
             'DEMO_SEED', 'DEMO-PAY-0001', 'Payment on account',
             now(), now(), true
        FROM platform.taxpayer p
       WHERE p.tin = '1234567890'
         AND NOT EXISTS (SELECT 1 FROM tax.taxpayer_account_entry
                          WHERE source_reference = 'DEMO-PAY-0001')
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO tax.taxpayer_account_entry
              (taxpayer_id, tax_type_code, assessment_year, entry_type, credit_code,
               amount, currency_code, is_non_refundable, value_date,
               source_system, source_reference, narrative,
               created_at, updated_at, is_active)
      SELECT p.id, 'CIT', '2024', 'WITHHOLDING_CREDIT', 'CIT_INTEREST_WHT',
             2500.0000, 'GBP', true, '2024-11-30',
             'DEMO_SEED', 'DEMO-WHT-0001', 'Tax withheld at source on interest',
             now(), now(), true
        FROM platform.taxpayer p
       WHERE p.tin = '1234567890'
         AND NOT EXISTS (SELECT 1 FROM tax.taxpayer_account_entry
                          WHERE source_reference = 'DEMO-WHT-0001')
    `);

    /** A brought-forward trading loss, so the set-off step has something to do. */
    await queryInterface.sequelize.query(`
      INSERT INTO tax.taxpayer_loss
              (taxpayer_id, tax_type_code, origin_year, loss_type,
               original_amount, consumed_amount, currency_code,
               expires_after_year, created_at, updated_at, is_active)
      SELECT p.id, 'CIT', '2022', 'TRADING',
             30000.0000, 0, 'GBP',
             NULL, now(), now(), true
        FROM platform.taxpayer p
       WHERE p.tin = '1234567890'
         AND NOT EXISTS (SELECT 1 FROM tax.taxpayer_loss l
                          WHERE l.taxpayer_id = p.id AND l.origin_year = '2022')
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM tax.taxpayer_account_entry WHERE source_system = 'DEMO_SEED'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tax.taxpayer_loss WHERE origin_year = '2022'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM forms.form_template_data WHERE reference_number = 'CIT-2024-000001'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM forms.form_template WHERE template_code = 'CIT-RETURN-GB'`,
    );
  },
};
