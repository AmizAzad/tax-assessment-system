'use strict';

/**
 * Form categories, templates and submissions.
 *
 * Plan reference: V2 sections 4.2, 4.3; ADR-005, ADR-006.
 *
 * Two inherited mechanisms are kept deliberately because they map straight
 * onto tax requirements (plan 4.2):
 *
 *   - `previous_submission_uuid` gives a supersession chain, which is how a
 *     revised assessment links to the one it replaces.
 *   - the category reference pattern gives case and notice numbers without
 *     new code.
 *
 * Versioning is clone-per-year (plan 4.3): a template is never edited once
 * published, because a submission must stay renderable against the exact
 * template that produced it. `derived_from_template_id` keeps the year-on-year
 * family queryable.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = Sequelize.literal('CURRENT_TIMESTAMP');

    const audit = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      created_by: { type: DataTypes.BIGINT, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      updated_by: { type: DataTypes.BIGINT, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    };

    await queryInterface.createTable(
      { schema: 'forms', tableName: 'form_category' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        category_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        parent_id: { type: DataTypes.BIGINT, allowNull: true },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: true },
        // e.g. TA{YYYY}{SEQ:8}. Case and notice numbers come from here.
        reference_pattern: { type: DataTypes.STRING(64), allowNull: true },
        dashboard_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'forms', tableName: 'form_template' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        category_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'forms', tableName: 'form_category' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        // The stable business handle, e.g. TA-06. Several versions share it.
        template_code: { type: DataTypes.STRING(64), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        // The element tree. JSONB is right here: the shape is genuinely
        // dynamic and nothing queries inside it (plan 2.7).
        definition: { type: DataTypes.JSONB, allowNull: false },
        schema_version: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '1.0.0' },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        // The clone this template came from, so a year-on-year family is
        // queryable rather than only discoverable by naming convention.
        derived_from_template_id: { type: DataTypes.BIGINT, allowNull: true },
        // Assessment year or period this version applies to.
        applies_to_year: { type: DataTypes.STRING(16), allowNull: true },
        is_login_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        published_at: { type: DataTypes.DATE, allowNull: true },
        published_by: { type: DataTypes.BIGINT, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'forms', tableName: 'form_template' },
      {
        fields: ['template_code', 'version'],
        type: 'unique',
        name: 'form_template_code_version_unique',
      },
    );

    await queryInterface.createTable(
      { schema: 'forms', tableName: 'form_template_data' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        // Pinned, never repointed: a historic submission must stay renderable
        // against the exact template that produced it.
        form_template_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'forms', tableName: 'form_template' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        // The authoring record: what the officer actually filled in. The
        // computational and reporting record is the normalised domain tables.
        json: { type: DataTypes.JSONB, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        // The supersession chain. A revised assessment points at the one it
        // replaces rather than overwriting it.
        previous_submission_uuid: { type: DataTypes.UUID, allowNull: true },
        reference_number: { type: DataTypes.STRING(64), allowNull: true, unique: true },
        submission_unique_identifier: { type: DataTypes.STRING(128), allowNull: true },
        // What this submission belongs to, e.g. a case.
        context_type: { type: DataTypes.STRING(64), allowNull: true },
        context_id: { type: DataTypes.BIGINT, allowNull: true },
        submitted_by: { type: DataTypes.BIGINT, allowNull: true },
        submitted_at: { type: DataTypes.DATE, allowNull: true },
        approved_by: { type: DataTypes.BIGINT, allowNull: true },
        comment: { type: DataTypes.TEXT, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addIndex(
      { schema: 'forms', tableName: 'form_template_data' },
      ['context_type', 'context_id'],
      { name: 'ix_submission_context' },
    );
    await queryInterface.addIndex(
      { schema: 'forms', tableName: 'form_template_data' },
      ['submission_unique_identifier'],
      { name: 'ix_submission_identifier' },
    );

    /**
     * Reference number allocation.
     *
     * A dedicated sequence table rather than max()+1: case numbers must be
     * unique under concurrency, and some jurisdictions require them gapless,
     * which a scan-and-increment cannot promise.
     */
    await queryInterface.createTable(
      { schema: 'forms', tableName: 'reference_sequence' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        sequence_key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        next_value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 1 },
        ...audit,
      },
    );

    // ---------------------------------------------------------------- seeds
    const stamp = { created_at: new Date(), updated_at: new Date(), is_active: true };
    await queryInterface.bulkInsert({ schema: 'forms', tableName: 'form_category' }, [
      {
        category_code: 'TAX',
        display_key: 'ta.category.taxAssessment',
        jurisdiction_code: 'GB',
        reference_pattern: 'TA{YYYY}{SEQ:8}',
        dashboard_enabled: true,
        ...stamp,
      },
    ]);

    const [categories] = await queryInterface.sequelize.query(
      `SELECT id FROM forms.form_category WHERE category_code = 'TAX'`,
    );
    const taxCategoryId = categories[0].id;

    await queryInterface.bulkInsert({ schema: 'forms', tableName: 'form_category' }, [
      {
        category_code: 'TAX-CIT',
        display_key: 'ta.category.corporationTax',
        parent_id: taxCategoryId,
        jurisdiction_code: 'GB',
        reference_pattern: 'TA{YYYY}{SEQ:8}',
        ...stamp,
      },
      {
        category_code: 'TAX-VAT',
        display_key: 'ta.category.valueAddedTax',
        parent_id: taxCategoryId,
        jurisdiction_code: 'GB',
        reference_pattern: 'TA{YYYY}{SEQ:8}',
        ...stamp,
      },
    ]);
  },

  async down(queryInterface) {
    for (const tableName of [
      'reference_sequence',
      'form_template_data',
      'form_template',
      'form_category',
    ]) {
      await queryInterface.dropTable({ schema: 'forms', tableName });
    }
  },
};
