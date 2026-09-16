'use strict';

/**
 * Reference and master data.
 *
 * Plan reference: V2 section 6.2.
 *
 * One design choice worth stating: jurisdiction catalogues (adjustment
 * reasons, objection grounds, appeal forums, closure reasons) share a single
 * `master_data` / `master_data_item` pair rather than getting a table each.
 * A table per list means a migration per jurisdiction, which defeats the whole
 * "new jurisdiction = zero code" acceptance criterion.
 *
 * Structural reference data that the code reasons about -- tax types, periods,
 * currencies, calendars -- does get real tables, because it has real columns
 * and real foreign keys.
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

    // ------------------------------------------------------- generic catalogues
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'master_data' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        // e.g. ADJUSTMENT_REASON, OBJECTION_GROUND, APPEAL_FORUM, CLOSURE_REASON
        group_code: { type: DataTypes.STRING(64), allowNull: false },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'master_data' },
      {
        fields: ['group_code', 'jurisdiction_code'],
        type: 'unique',
        name: 'master_data_group_jurisdiction_unique',
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'master_data_item' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        master_data_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'master_data' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        item_code: { type: DataTypes.STRING(64), allowNull: false },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        // Lets one catalogue filter another: an adjustment reason valid only
        // for a given adjustment type carries the type as its parent.
        parent_item_id: { type: DataTypes.BIGINT, allowNull: true },
        sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // Free-form per-item configuration (thresholds, flags). Never money.
        attributes_json: { type: DataTypes.JSONB, allowNull: true },
        effective_from: { type: DataTypes.DATEONLY, allowNull: true },
        effective_to: { type: DataTypes.DATEONLY, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'master_data_item' },
      {
        fields: ['master_data_id', 'item_code'],
        type: 'unique',
        name: 'master_data_item_code_unique',
      },
    );

    // ------------------------------------------------------------- currency
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'currency' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        currency_code: { type: DataTypes.STRING(3), allowNull: false, unique: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        // Minor-unit scale. Not all currencies are 2: JPY is 0, BHD is 3.
        decimal_places: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
        symbol: { type: DataTypes.STRING(8), allowNull: true },
        ...audit,
      },
    );

    // ------------------------------------------------------------- tax type
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'tax_type' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        tax_type_code: { type: DataTypes.STRING(32), allowNull: false },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        // Which taxpayer kinds this tax can apply to: LEGAL, NATURAL, or BOTH.
        applies_to: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'LEGAL' },
        default_currency_code: { type: DataTypes.STRING(3), allowNull: true },
        effective_from: { type: DataTypes.DATEONLY, allowNull: true },
        effective_to: { type: DataTypes.DATEONLY, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'tax_type' },
      {
        fields: ['tax_type_code', 'jurisdiction_code'],
        type: 'unique',
        name: 'tax_type_code_jurisdiction_unique',
      },
    );

    // --------------------------------------------------------- period model
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'period_frequency' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        frequency_code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        // MONTHLY, QUARTERLY, ANNUAL -> how many periods in a year.
        periods_per_year: { type: DataTypes.INTEGER, allowNull: false },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'tax_period' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        tax_period_code: { type: DataTypes.STRING(32), allowNull: false },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        tax_type_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'platform', tableName: 'tax_type' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        frequency_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'platform', tableName: 'period_frequency' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        period_start: { type: DataTypes.DATEONLY, allowNull: false },
        period_end: { type: DataTypes.DATEONLY, allowNull: false },
        // The label the period is assessed under. Not always the calendar year.
        assessment_year: { type: DataTypes.STRING(16), allowNull: false },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'tax_period' },
      {
        type: 'check',
        name: 'tax_period_range_ordered',
        fields: ['period_start'],
        where: Sequelize.literal('period_end >= period_start'),
      },
    );

    // ------------------------------------------------------------- calendars
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'filing_calendar' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        tax_type_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'tax_type' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        tax_period_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'tax_period' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        due_date: { type: DataTypes.DATEONLY, allowNull: false },
        grace_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        extension_date: { type: DataTypes.DATEONLY, allowNull: true },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'holiday' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        jurisdiction_code: { type: DataTypes.STRING(16), allowNull: false },
        holiday_date: { type: DataTypes.DATEONLY, allowNull: false },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'holiday' },
      {
        fields: ['jurisdiction_code', 'holiday_date'],
        type: 'unique',
        name: 'holiday_jurisdiction_date_unique',
      },
    );
    // The deadline engine scans this on every working-day computation.
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'holiday' },
      ['jurisdiction_code', 'holiday_date'],
      { name: 'ix_holiday_lookup' },
    );

    // ------------------------------------------------------ taxpayer contact
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'taxpayer_contact' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        taxpayer_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'taxpayer' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        contact_type: { type: DataTypes.STRING(32), allowNull: false },
        channel: { type: DataTypes.STRING(32), allowNull: false },
        value: { type: DataTypes.STRING(512), allowNull: false },
        // Exactly one contact per taxpayer is the address of record for
        // service of notices. Statutory clocks run from delivery to it.
        is_service_address: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        verified_at: { type: DataTypes.DATE, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX ux_taxpayer_service_address
        ON platform.taxpayer_contact (taxpayer_id)
        WHERE is_service_address AND is_active;
    `);

    // ---------------------------------------------------------------- seeds
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'currency' }, [
      { currency_code: 'GBP', display_key: 'ta.currency.GBP', decimal_places: 2, symbol: '£' },
      { currency_code: 'EUR', display_key: 'ta.currency.EUR', decimal_places: 2, symbol: '€' },
      { currency_code: 'USD', display_key: 'ta.currency.USD', decimal_places: 2, symbol: '$' },
      { currency_code: 'JPY', display_key: 'ta.currency.JPY', decimal_places: 0, symbol: '¥' },
      { currency_code: 'BHD', display_key: 'ta.currency.BHD', decimal_places: 3, symbol: '.د.ب' },
    ]);

    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'period_frequency' }, [
      { frequency_code: 'MONTHLY', display_key: 'ta.frequency.monthly', periods_per_year: 12 },
      { frequency_code: 'QUARTERLY', display_key: 'ta.frequency.quarterly', periods_per_year: 4 },
      { frequency_code: 'ANNUAL', display_key: 'ta.frequency.annual', periods_per_year: 1 },
    ]);
  },

  async down(queryInterface) {
    for (const tableName of [
      'taxpayer_contact',
      'holiday',
      'filing_calendar',
      'tax_period',
      'period_frequency',
      'tax_type',
      'currency',
      'master_data_item',
      'master_data',
    ]) {
      await queryInterface.dropTable({ schema: 'platform', tableName });
    }
  },
};
