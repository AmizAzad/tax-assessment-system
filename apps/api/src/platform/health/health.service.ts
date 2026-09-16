import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Sequelize } from 'sequelize';
import { REDIS_CLIENT, SEQUELIZE } from '../../infrastructure/tokens';

export type ComponentStatus = 'up' | 'down';

export interface HealthReport {
  readonly status: ComponentStatus;
  readonly checkedAt: string;
  readonly components: Readonly<Record<string, { status: ComponentStatus; detail?: string }>>;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);

    const components = { database, redis };
    const allUp = Object.values(components).every((component) => component.status === 'up');
    const report: HealthReport = {
      status: allUp ? 'up' : 'down',
      checkedAt: new Date().toISOString(),
      components,
    };

    if (!allUp) {
      // Signals the orchestrator to stop routing traffic here.
      throw new ServiceUnavailableException(report);
    }
    return report;
  }

  private async checkDatabase(): Promise<{ status: ComponentStatus; detail?: string }> {
    try {
      await this.sequelize.authenticate();
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: describe(error) };
    }
  }

  private async checkRedis(): Promise<{ status: ComponentStatus; detail?: string }> {
    try {
      const reply = await this.redis.ping();
      return reply === 'PONG'
        ? { status: 'up' }
        : { status: 'down', detail: `Unexpected PING reply: ${reply}` };
    } catch (error) {
      return { status: 'down', detail: describe(error) };
    }
  }
}

/** Never leak a stack trace or a connection string into a health response. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
