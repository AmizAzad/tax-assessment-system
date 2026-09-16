import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { currentCorrelationId } from '../auth/request-context';

export type NotificationChannel = 'EMAIL' | 'PORTAL' | 'SMS';

export interface SendRequest {
  readonly typeCode: string;
  readonly recipient: string;
  readonly recipientUserId?: number;
  readonly languageCode?: string;
  readonly channels?: readonly NotificationChannel[];
  /** Values substituted into the template. */
  readonly variables: Readonly<Record<string, string | number | null | undefined>>;
  /** What this is about, so a case timeline can include it. */
  readonly contextType?: string;
  readonly contextId?: number;
}

export interface QueuedNotification {
  readonly id: number;
  readonly channel: NotificationChannel;
  readonly status: string;
}

/**
 * Notification composition and queueing.
 *
 * Plan reference: V2 sections 6.4, 19.1.
 *
 * ## Queue, then send
 *
 * `send()` renders and persists; it does not deliver. Delivery is a separate
 * pass over the queue, for two reasons:
 *
 *   - a slow SMTP server must not hold a request thread open, and
 *   - `notification_history` is the communication audit. A notice is either
 *     recorded as due to be sent or it is not; a row that exists only in
 *     memory while a send is in flight can be lost, and "we have no record of
 *     despatching it" is not a position to be in when an objection deadline
 *     is disputed.
 *
 * The rendered body is stored, not just the template id: proving what a
 * taxpayer received requires the words they received, and templates change.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async send(request: SendRequest): Promise<readonly QueuedNotification[]> {
    const type = await this.findType(request.typeCode);
    if (type === undefined) {
      // An unknown type is a wiring bug. Loud, but not fatal to the business
      // operation that triggered it: failing to notify must not roll back a
      // finalised assessment.
      this.logger.error(
        `Notification type '${request.typeCode}' is not registered. Nothing was queued.`,
      );
      return [];
    }

    const languageCode = request.languageCode ?? 'en';
    const channels = request.channels ?? type.defaultChannels;
    const queued: QueuedNotification[] = [];

    for (const channel of channels) {
      const template = await this.findTemplate(type.id, channel, languageCode);

      if (template === undefined) {
        this.logger.warn(
          `No ${channel}/${languageCode} template for '${request.typeCode}'; skipping that channel`,
        );
        continue;
      }

      const subject =
        template.subjectTemplate === null
          ? null
          : render(template.subjectTemplate, request.variables);
      const body = render(template.bodyTemplate, request.variables);

      const rows = await this.sequelize.query<{ id: string }>(
        `INSERT INTO platform.notification_history
                (type_code, channel, language_code, template_version, recipient,
                 recipient_user_id, subject, body, context_type, context_id,
                 status, correlation_id)
         VALUES (:typeCode, :channel, :languageCode, :templateVersion, :recipient,
                 :recipientUserId, :subject, :body, :contextType, :contextId,
                 'PENDING', :correlationId)
         RETURNING id`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            typeCode: request.typeCode,
            channel,
            languageCode,
            templateVersion: template.version,
            recipient: request.recipient,
            recipientUserId: request.recipientUserId ?? null,
            subject,
            body,
            contextType: request.contextType ?? null,
            contextId: request.contextId ?? null,
            correlationId: currentCorrelationId() ?? null,
          },
        },
      );

      queued.push({
        id: Number(rows[0]!.id),
        channel,
        status: 'PENDING',
      });
    }

    return queued;
  }

  /** Everything waiting to go out, oldest first. Read by the dispatcher. */
  async pending(limit = 50): Promise<
    Array<{
      id: number;
      channel: NotificationChannel;
      recipient: string;
      subject: string | null;
      body: string;
      attemptCount: number;
    }>
  > {
    const rows = await this.sequelize.query<{
      id: string;
      channel: string;
      recipient: string;
      subject: string | null;
      body: string;
      attempt_count: number;
    }>(
      `SELECT id, channel, recipient, subject, body, attempt_count
         FROM platform.notification_history
        WHERE status = 'PENDING'
        ORDER BY queued_at
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { limit } },
    );

    return rows.map((row) => ({
      id: Number(row.id),
      channel: row.channel as NotificationChannel,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      attemptCount: row.attempt_count,
    }));
  }

  async markSent(id: number, providerReference?: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE platform.notification_history
          SET status = 'SENT',
              sent_at = CURRENT_TIMESTAMP,
              provider_reference = :providerReference,
              attempt_count = attempt_count + 1
        WHERE id = :id`,
      {
        type: QueryTypes.UPDATE,
        replacements: { id, providerReference: providerReference ?? null },
      },
    );
  }

  /**
   * Record a failed attempt.
   *
   * Gives up after `maxAttempts` and marks FAILED, rather than retrying
   * forever: a permanently bad address should surface as a delivery failure an
   * officer can act on, not as an endlessly retrying queue entry.
   */
  async markFailed(id: number, reason: string, maxAttempts = 3): Promise<void> {
    await this.sequelize.query(
      `UPDATE platform.notification_history
          SET attempt_count = attempt_count + 1,
              failure_reason = :reason,
              status = CASE WHEN attempt_count + 1 >= :maxAttempts THEN 'FAILED' ELSE 'PENDING' END
        WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id, reason, maxAttempts } },
    );
  }

  /** Communication history for one case, for the audit timeline. */
  async historyFor(
    contextType: string,
    contextId: number,
  ): Promise<
    Array<{
      typeCode: string;
      channel: string;
      recipient: string;
      status: string;
      queuedAt: Date;
      sentAt: Date | null;
    }>
  > {
    const rows = await this.sequelize.query<{
      type_code: string;
      channel: string;
      recipient: string;
      status: string;
      queued_at: Date;
      sent_at: Date | null;
    }>(
      `SELECT type_code, channel, recipient, status, queued_at, sent_at
         FROM platform.notification_history
        WHERE context_type = :contextType AND context_id = :contextId
        ORDER BY queued_at DESC`,
      { type: QueryTypes.SELECT, replacements: { contextType, contextId } },
    );

    return rows.map((row) => ({
      typeCode: row.type_code,
      channel: row.channel,
      recipient: row.recipient,
      status: row.status,
      queuedAt: row.queued_at,
      sentAt: row.sent_at,
    }));
  }

  private async findType(
    typeCode: string,
  ): Promise<{ id: number; defaultChannels: NotificationChannel[] } | undefined> {
    const rows = await this.sequelize.query<{ id: string; default_channels: string[] }>(
      `SELECT id, default_channels FROM platform.notification_type
        WHERE type_code = :typeCode AND is_active`,
      { type: QueryTypes.SELECT, replacements: { typeCode } },
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { id: Number(row.id), defaultChannels: row.default_channels as NotificationChannel[] };
  }

  private async findTemplate(
    notificationTypeId: number,
    channel: string,
    languageCode: string,
  ): Promise<
    { subjectTemplate: string | null; bodyTemplate: string; version: number } | undefined
  > {
    const rows = await this.sequelize.query<{
      subject_template: string | null;
      body_template: string;
      version: number;
    }>(
      `SELECT subject_template, body_template, version
         FROM platform.notification_template
        WHERE notification_type_id = :notificationTypeId
          AND channel = :channel
          AND language_code = :languageCode
          AND is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { notificationTypeId, channel, languageCode },
      },
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          subjectTemplate: row.subject_template,
          bodyTemplate: row.body_template,
          version: row.version,
        };
  }
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * An unresolved placeholder is left visible rather than replaced with a blank.
 * A notice reading "Please respond by {{responseDeadline}}" is obviously
 * broken; one reading "Please respond by " looks deliberate and would be
 * served to a taxpayer.
 */
export function render(
  template: string,
  variables: Readonly<Record<string, string | number | null | undefined>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = variables[name];
    return value === null || value === undefined ? placeholder : String(value);
  });
}
