import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { HealthService, type HealthReport } from './health.service';

/**
 * Liveness and readiness.
 *
 * Plan reference: V2 section 25.2 Phase 0 exit criterion.
 *
 * Readiness deliberately reports Redis as a hard dependency rather than a
 * degraded-but-serving condition: authorisation fails closed without it
 * (plan section 6.1), so an instance that cannot reach Redis cannot authorise
 * anyone and must be taken out of the load balancer rather than left to
 * return 403 to every caller.
 */
@ApiTags('health')
@Controller('health')
// Probed by the orchestrator, which has no token. These are the only routes
// in the platform module that are reachable unauthenticated.
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is running' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: dependencies are reachable' })
  async ready(): Promise<HealthReport> {
    return this.health.check();
  }
}
