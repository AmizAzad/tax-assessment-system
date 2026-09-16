import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * The scheduled-work process.
 *
 * Plan reference: V2 sections 6.6, 27.4.
 *
 * ## Why a separate process at all
 *
 * The API's job is to answer requests quickly. Sweeping every open deadline in
 * the register, or closing two hundred settled cases, is work that takes as
 * long as it takes and should not be competing for the same event loop as a
 * caseworker waiting for a page to load. Separating them also means the two
 * can be scaled and restarted independently: an API deployment no longer
 * interrupts a sweep half way through.
 *
 * ## Why it is an application context, not an HTTP server
 *
 * `createApplicationContext` builds the same dependency graph without opening
 * a port. A worker that listened would be a second copy of the API with the
 * same routes and its own attack surface, reachable by anything that could
 * find it.
 *
 * ## What stops both processes doing the same work
 *
 * Every scheduled job runs through `JobRegistryService.runExclusively`, which
 * claims the job with a conditional update. Whichever process wins runs it;
 * the others skip. That is what makes running the API and the worker together
 * safe, and it is also what makes more than one worker replica safe.
 *
 * In development the API still schedules, so a single `npm run start:dev`
 * behaves as before. In a deployment, set `SCHEDULER_ENABLED=false` on the API
 * and leave it true here.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const context = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  // Buffered logs are held until this is called. An HTTP app flushes when it
  // starts listening; an application context never listens, so without this
  // the worker runs perfectly and prints nothing -- which is indistinguishable
  // from a process that died on boot.
  context.flushLogs();

  context.enableShutdownHooks();

  // Explicit, because a worker that has started and is doing nothing looks
  // exactly like a worker that has crashed silently.
  logger.log('Tax Assessment worker started. Scheduled jobs are claimed exclusively.');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received; finishing the current job before exit.`);
    await context.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
