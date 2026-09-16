'use strict';

/**
 * UK corporation tax filing and payment deadlines, FY2024.
 *
 * Plan reference: V2 sections 10.1 to 10.3.
 *
 * ## The secondary offset
 *
 * The UK payment deadline for a company outside the quarterly-instalment
 * regime is nine months and one day after the end of the accounting period.
 * A single offset value and unit cannot express that, and the alternatives are
 * all worse: rounding to nine months moves the deadline a day early and
 * manufactures a day of interest against every taxpayer, while hard-coding the
 * extra day in the engine puts a UK rule inside jurisdiction-neutral code.
 *
 * So the configuration gains a second offset applied after the first. It
 * generalises beyond this case: "two months and fifteen days" is a common
 * shape in other jurisdictions.
 *
 * ## Sources
 *
 * Filing: twelve months from the end of the accounting period, Finance Act
 * 1998 Schedule 18 paragraph 14. Payment: nine months and one day after the
 * end of the accounting period, Corporation Tax Act 2010 section 1069 for
 * companies not liable to pay by instalments.
 *
 * These were established from public guidance rather than from a subscription
 * legislative service, and carry the same SME sign-off caveat as the rate
 * seed in 20261002000200. They are configuration, so correcting one is a data
 * change and not a deployment.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { INTEGER, STRING } = Sequelize;

    await queryInterface.addColumn(
      { schema: 'tax', tableName: 'tax_deadline_config' },
      'secondary_offset_value',
      { type: INTEGER, allowNull: true },
    );

    await queryInterface.addColumn(
      { schema: 'tax', tableName: 'tax_deadline_config' },
      'secondary_offset_unit',
      { type: STRING(10), allowNull: true },
    );

    // Half a rule is worse than none: an offset value with no unit would be
    // applied as whatever the engine happened to default to.
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_deadline_config
        ADD CONSTRAINT deadline_secondary_offset_complete
        CHECK ((secondary_offset_value IS NULL) = (secondary_offset_unit IS NULL))
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO tax.tax_deadline_config
        (jurisdiction_code, tax_type_code, deadline_type, anchor_event,
         offset_value, offset_unit, calendar_rule,
         secondary_offset_value, secondary_offset_unit,
         effective_from, created_at, updated_at, is_active)
      VALUES
        ('GB', 'CIT', 'FILING',  'PERIOD_END', 12, 'MONTHS', 'CALENDAR_DAYS',
         NULL, NULL, '2023-04-01', now(), now(), true),
        ('GB', 'CIT', 'PAYMENT', 'PERIOD_END',  9, 'MONTHS', 'CALENDAR_DAYS',
         1, 'DAYS', '2023-04-01', now(), now(), true)
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM tax.tax_deadline_config
       WHERE jurisdiction_code = 'GB' AND tax_type_code = 'CIT'
         AND deadline_type IN ('FILING', 'PAYMENT')
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE tax.tax_deadline_config
        DROP CONSTRAINT IF EXISTS deadline_secondary_offset_complete
    `);
    await queryInterface.removeColumn(
      { schema: 'tax', tableName: 'tax_deadline_config' },
      'secondary_offset_unit',
    );
    await queryInterface.removeColumn(
      { schema: 'tax', tableName: 'tax_deadline_config' },
      'secondary_offset_value',
    );
  },
};
