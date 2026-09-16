'use strict';

/**
 * The Saudi corporate income tax type.
 *
 * Plan reference: V2 sections 7.3, 23.
 *
 * ## Why this is a separate migration
 *
 * `20261006000100` configured the second jurisdiction and was believed
 * complete. Opening a case against it proved otherwise: the case was created
 * in GBP, because `platform.tax_type` had no SA row and the fallback chain had
 * nowhere left to look.
 *
 * That is the second-jurisdiction exercise doing exactly what it is for. The
 * gap is recorded as its own migration rather than folded back into the first,
 * because the first has already been applied and rewriting applied history
 * makes two databases that claim the same version disagree.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO platform.tax_type
        (tax_type_code, jurisdiction_code, display_key, description, applies_to,
         default_currency_code, effective_from, created_at, updated_at, is_active)
      SELECT 'CIT', 'SA', 'ta.taxType.cit', 'Corporate income tax', 'COMPANY',
             'SAR', '2024-01-01', now(), now(), true
       WHERE NOT EXISTS (
         SELECT 1 FROM platform.tax_type
          WHERE tax_type_code = 'CIT' AND jurisdiction_code = 'SA')
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM platform.tax_type WHERE jurisdiction_code = 'SA'`,
    );
  },
};
