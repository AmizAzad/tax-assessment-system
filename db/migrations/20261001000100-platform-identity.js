'use strict';

/**
 * Platform identity and access model.
 *
 * Plan reference: V2 sections 6.1 and 13.2.
 *
 * Authentication is Keycloak's (ADR-003). What lives here is authorisation:
 * the local user mirror, roles, the permission catalogue, menus and
 * delegation. Role codes are the currency of the whole system -- they appear
 * on BPMN user tasks, on permission mappings and in scope predicates.
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

    // ----------------------------------------------------------------- users
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'app_user' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        // The Keycloak subject claim. This is the join key to the IdP and the
        // reason we never store a password.
        external_subject: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        username: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        display_name: { type: DataTypes.STRING(255), allowNull: false },
        email: { type: DataTypes.STRING(320), allowNull: true },
        department_id: { type: DataTypes.BIGINT, allowNull: true },
        preferred_language: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en' },
        last_login_at: { type: DataTypes.DATE, allowNull: true },
        ...audit,
      },
    );

    // ----------------------------------------------------------------- roles
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'role' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        role_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        role_name: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        role_type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'INTERNAL' },
        department_id: { type: DataTypes.BIGINT, allowNull: true },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'user_role' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        user_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'app_user' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        role_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'role' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        // A role grant may be time-boxed; this is how a temporary assignment
        // expires without anyone remembering to revoke it.
        valid_from: { type: DataTypes.DATE, allowNull: true },
        valid_to: { type: DataTypes.DATE, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'user_role' },
      { fields: ['user_id', 'role_id'], type: 'unique', name: 'user_role_unique' },
    );

    // ----------------------------------------------------------- delegation
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'delegation' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        delegator_user_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'app_user' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        delegate_user_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'app_user' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        role_code: { type: DataTypes.STRING(64), allowNull: false },
        valid_from: { type: DataTypes.DATE, allowNull: false },
        valid_to: { type: DataTypes.DATE, allowNull: false },
        reason: { type: DataTypes.TEXT, allowNull: false },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'delegation' },
      {
        type: 'check',
        name: 'delegation_window_ordered',
        fields: ['valid_from'],
        where: Sequelize.literal('valid_to > valid_from'),
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'delegation' },
      {
        type: 'check',
        name: 'delegation_not_self',
        fields: ['delegate_user_id'],
        where: Sequelize.literal('delegate_user_id <> delegator_user_id'),
      },
    );

    // ---------------------------------------------------- permission catalogue
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'menu' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        menu_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        parent_id: { type: DataTypes.BIGINT, allowNull: true },
        route: { type: DataTypes.STRING(255), allowNull: true },
        icon: { type: DataTypes.STRING(64), allowNull: true },
        sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        max_permission_level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'permission' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        // The route key, e.g. 'POST /api/v1/cases'. Every API route is
        // registered here by migration; an unregistered route is unreachable
        // because authorisation fails closed.
        permission_key: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        menu_id: {
          type: DataTypes.BIGINT,
          allowNull: true,
          references: { model: { schema: 'platform', tableName: 'menu' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        // 10 VIEW, 20 EDIT, 30 FULL. Hierarchical: FULL implies EDIT implies VIEW.
        required_level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
        description: { type: DataTypes.TEXT, allowNull: true },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'role_permission' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        role_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'role' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        permission_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'permission' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        granted_level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'role_permission' },
      { fields: ['role_id', 'permission_id'], type: 'unique', name: 'role_permission_unique' },
    );

    // --------------------------------------------------------------- indexes
    await queryInterface.addIndex({ schema: 'platform', tableName: 'user_role' }, ['user_id'], {
      name: 'ix_user_role_user',
    });
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'role_permission' },
      ['role_id'],
      { name: 'ix_role_permission_role' },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'delegation' },
      ['delegate_user_id', 'valid_from', 'valid_to'],
      { name: 'ix_delegation_active' },
    );
  },

  async down(queryInterface) {
    for (const tableName of [
      'role_permission',
      'permission',
      'menu',
      'delegation',
      'user_role',
      'role',
      'app_user',
    ]) {
      await queryInterface.dropTable({ schema: 'platform', tableName });
    }
  },
};
