import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../infrastructure/tokens';
import { NotificationService } from './notification.service';

export interface DispatchReport {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

/**
 * Delivers queued notifications.
 *
 * Plan reference: V2 sections 6.4, 17.3.
 *
 * Runs on a schedule rather than inline, so a slow or unreachable SMTP server
 * delays a notice rather than failing the business operation that triggered it.
 * Finalising an assessment must not roll back because a mail server was busy.
 *
 * ## Channels
 *
 * EMAIL goes through SMTP — Mailpit locally, a real relay when deployed.
 * PORTAL is a no-op delivery: the notification row *is* the portal message,
 * and marking it sent is what makes it visible. SMS has no provider yet and is
 * deliberately left failing rather than silently dropped, so that enabling an
 * SMS channel without a provider is visible rather than quiet.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly notifications: NotificationService,
  ) {
    this.from = config.smtp.from;
    this.transport = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // Mailpit accepts plaintext on 1025. A deployed relay needs TLS, which
      // is why this follows the port rather than being hard-coded off.
      secure: config.smtp.port === 465,
      ignoreTLS: config.smtp.port === 1025,
    });
  }

  async dispatchPending(batchSize = 50): Promise<DispatchReport> {
    const pending = await this.notifications.pending(batchSize);
    let sent = 0;
    let failed = 0;

    for (const item of pending) {
      try {
        switch (item.channel) {
          case 'EMAIL': {
            const result = await this.transport.sendMail({
              from: this.from,
              to: item.recipient,
              subject: item.subject ?? '(no subject)',
              text: item.body,
            });
            await this.notifications.markSent(item.id, result.messageId);
            sent += 1;
            break;
          }

          case 'PORTAL':
            // The row is the message. Nothing to transmit.
            await this.notifications.markSent(item.id, 'portal');
            sent += 1;
            break;

          case 'SMS':
            await this.notifications.markFailed(
              item.id,
              'No SMS provider is configured for this deployment',
            );
            failed += 1;
            break;

          default:
            await this.notifications.markFailed(
              item.id,
              `Unknown channel '${String(item.channel)}'`,
            );
            failed += 1;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown delivery error';
        await this.notifications.markFailed(item.id, reason);
        failed += 1;
        this.logger.warn(`Delivery of notification ${item.id} failed: ${reason}`);
      }
    }

    if (pending.length > 0) {
      this.logger.log(`Dispatched ${sent} notification(s), ${failed} failed`);
    }

    return { attempted: pending.length, sent, failed };
  }

  /** Whether the mail transport is reachable. Used by readiness diagnostics. */
  async verifyTransport(): Promise<boolean> {
    try {
      await this.transport.verify();
      return true;
    } catch (error) {
      this.logger.warn(
        `SMTP is not reachable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return false;
    }
  }
}
