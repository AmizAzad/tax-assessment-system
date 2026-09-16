'use strict';

/**
 * Document storage and notification delivery.
 *
 * Plan reference: V2 sections 6.3, 6.4, 19.1.
 *
 * Two things here are audit records rather than operational conveniences, and
 * are treated accordingly:
 *
 *   - `document_access_log` answers "who read this taxpayer's evidence", which
 *     is a question an auditor will ask.
 *   - `notification_history` is the communication audit: it is what proves a
 *     notice was despatched, to which address, and what happened to it. The
 *     statutory clock for an objection runs from service, so this is evidence.
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

    // ------------------------------------------------------------- documents
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'document' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        uuid: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        // The object key in storage. Never returned to a client: responses
        // carry a signed, expiring URL instead (plan section 20).
        storage_key: { type: DataTypes.STRING(512), allowNull: false, unique: true },
        filename: { type: DataTypes.STRING(512), allowNull: false },
        content_type: { type: DataTypes.STRING(128), allowNull: false },
        size_bytes: { type: DataTypes.BIGINT, allowNull: false },
        // SHA-256, computed on upload and verified on download. This is what
        // makes an evidence artefact tamper-evident.
        checksum_sha256: { type: DataTypes.STRING(64), allowNull: false },
        // Polymorphic owner: which case, notice or submission this belongs to.
        owner_type: { type: DataTypes.STRING(64), allowNull: true },
        owner_id: { type: DataTypes.BIGINT, allowNull: true },
        classification: {
          type: DataTypes.STRING(32),
          allowNull: false,
          defaultValue: 'TAXPAYER_CONFIDENTIAL',
        },
        retention_class: { type: DataTypes.STRING(32), allowNull: true },
        // Blocks retention-driven deletion regardless of retention class.
        legal_hold: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        uploaded_by: { type: DataTypes.BIGINT, allowNull: true },
        ...audit,
      },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'document' },
      ['owner_type', 'owner_id'],
      { name: 'ix_document_owner' },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'document_access_log' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        document_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'document' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        action: { type: DataTypes.STRING(32), allowNull: false },
        actor_user_id: { type: DataTypes.BIGINT, allowNull: true },
        actor_role_codes: { type: DataTypes.JSONB, allowNull: true },
        correlation_id: { type: DataTypes.STRING(64), allowNull: true },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
      },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'document_access_log' },
      ['document_id', 'occurred_at'],
      { name: 'ix_document_access_document' },
    );

    // --------------------------------------------------------- notifications
    await queryInterface.createTable(
      { schema: 'platform', tableName: 'notification_type' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        type_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        display_key: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        default_channels: { type: DataTypes.JSONB, allowNull: false },
        // Statutory communications cannot be opted out of.
        is_mandatory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ...audit,
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'notification_template' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        notification_type_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
          references: { model: { schema: 'platform', tableName: 'notification_type' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        channel: { type: DataTypes.STRING(32), allowNull: false },
        language_code: { type: DataTypes.STRING(10), allowNull: false },
        subject_template: { type: DataTypes.TEXT, allowNull: true },
        body_template: { type: DataTypes.TEXT, allowNull: false },
        // Bumped whenever the wording changes, and recorded on every send:
        // "which wording did this taxpayer actually receive" must be answerable.
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        ...audit,
      },
    );
    await queryInterface.addConstraint(
      { schema: 'platform', tableName: 'notification_template' },
      {
        fields: ['notification_type_id', 'channel', 'language_code'],
        type: 'unique',
        name: 'notification_template_unique',
      },
    );

    await queryInterface.createTable(
      { schema: 'platform', tableName: 'notification_history' },
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        type_code: { type: DataTypes.STRING(64), allowNull: false },
        channel: { type: DataTypes.STRING(32), allowNull: false },
        language_code: { type: DataTypes.STRING(10), allowNull: true },
        template_version: { type: DataTypes.INTEGER, allowNull: true },
        recipient: { type: DataTypes.STRING(512), allowNull: false },
        recipient_user_id: { type: DataTypes.BIGINT, allowNull: true },
        subject: { type: DataTypes.TEXT, allowNull: true },
        // The rendered body is kept: proving what was sent requires the words
        // that were sent, not a template that may since have changed.
        body: { type: DataTypes.TEXT, allowNull: true },
        // What this notification is about, so a case timeline can include it.
        context_type: { type: DataTypes.STRING(64), allowNull: true },
        context_id: { type: DataTypes.BIGINT, allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING' },
        provider_reference: { type: DataTypes.STRING(255), allowNull: true },
        failure_reason: { type: DataTypes.TEXT, allowNull: true },
        attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        queued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
        sent_at: { type: DataTypes.DATE, allowNull: true },
        correlation_id: { type: DataTypes.STRING(64), allowNull: true },
      },
    );
    await queryInterface.addIndex(
      { schema: 'platform', tableName: 'notification_history' },
      ['context_type', 'context_id'],
      { name: 'ix_notification_context' },
    );
    await queryInterface.sequelize.query(`
      CREATE INDEX ix_notification_pending
        ON platform.notification_history (queued_at)
        WHERE status = 'PENDING';
    `);

    // ---------------------------------------------------------------- seeds
    const stamp = { created_at: new Date(), updated_at: new Date(), is_active: true };
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'notification_type' }, [
      {
        type_code: 'TA_CASE_INITIATED',
        display_key: 'ta.notification.caseInitiated',
        default_channels: JSON.stringify(['EMAIL', 'PORTAL']),
        is_mandatory: false,
        ...stamp,
      },
      {
        type_code: 'TA_CASE_ASSIGNED',
        display_key: 'ta.notification.caseAssigned',
        default_channels: JSON.stringify(['EMAIL', 'PORTAL']),
        is_mandatory: false,
        ...stamp,
      },
      {
        type_code: 'TA_INFORMATION_REQUESTED',
        display_key: 'ta.notification.informationRequested',
        default_channels: JSON.stringify(['EMAIL', 'PORTAL']),
        is_mandatory: true,
        ...stamp,
      },
      {
        type_code: 'TA_NOTICE_SERVED',
        display_key: 'ta.notification.noticeServed',
        default_channels: JSON.stringify(['EMAIL', 'PORTAL']),
        is_mandatory: true,
        ...stamp,
      },
      {
        type_code: 'TA_DEADLINE_APPROACHING',
        display_key: 'ta.notification.deadlineApproaching',
        default_channels: JSON.stringify(['EMAIL']),
        is_mandatory: false,
        ...stamp,
      },
    ]);

    const [types] = await queryInterface.sequelize.query(
      'SELECT id, type_code FROM platform.notification_type',
    );
    const typeId = new Map(types.map((t) => [t.type_code, t.id]));

    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'notification_template' }, [
      {
        notification_type_id: typeId.get('TA_CASE_ASSIGNED'),
        channel: 'EMAIL',
        language_code: 'en',
        subject_template: 'Assessment {{caseNumber}} has been assigned to you',
        body_template:
          'Case {{caseNumber}} for {{taxpayerName}} ({{taxTypeCode}}, {{assessmentYear}}) ' +
          'has been assigned to you.\n\nTarget completion: {{targetDate}}',
        version: 1,
        ...stamp,
      },
      {
        notification_type_id: typeId.get('TA_INFORMATION_REQUESTED'),
        channel: 'EMAIL',
        language_code: 'en',
        subject_template: 'Information required for assessment {{caseNumber}}',
        body_template:
          'We require further information in connection with assessment {{caseNumber}}.\n\n' +
          '{{requestText}}\n\nPlease respond by {{responseDeadline}}.',
        version: 1,
        ...stamp,
      },
      {
        notification_type_id: typeId.get('TA_DEADLINE_APPROACHING'),
        channel: 'EMAIL',
        language_code: 'en',
        subject_template: 'Deadline approaching for {{caseNumber}}',
        body_template:
          'The {{deadlineType}} deadline for case {{caseNumber}} falls on {{dueAt}} ' +
          '({{daysRemaining}} days remaining).',
        version: 1,
        ...stamp,
      },
    ]);
  },

  async down(queryInterface) {
    for (const tableName of [
      'notification_history',
      'notification_template',
      'notification_type',
      'document_access_log',
      'document',
    ]) {
      await queryInterface.dropTable({ schema: 'platform', tableName });
    }
  },
};
