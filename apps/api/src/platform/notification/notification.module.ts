import { Global, Module } from '@nestjs/common';
import { NotificationDispatcher } from './notification.dispatcher';
import { NotificationService } from './notification.service';

/**
 * Notification composition, queueing and delivery.
 *
 * The service queues; the dispatcher delivers. Separate because a slow SMTP
 * server must not hold a request thread, and because the queue row is the
 * communication audit record.
 */
@Global()
@Module({
  providers: [NotificationService, NotificationDispatcher],
  exports: [NotificationService, NotificationDispatcher],
})
export class NotificationModule {}
