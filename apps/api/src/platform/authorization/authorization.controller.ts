import { Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import type { RequestContext } from '../auth/request-context';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionLevel } from './permission.model';

interface MeResponse {
  readonly username?: string;
  readonly userId?: number;
  readonly roleCodes: readonly string[];
  readonly jurisdictionCode: string;
  /** Routes this caller may invoke, so the SPA can render a menu. */
  readonly permissions: readonly string[];
}

@ApiTags('authorization')
@Controller()
export class AuthorizationController {
  constructor(private readonly permissionCache: PermissionCacheService) {}

  @Get('me')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The caller identity and effective permissions' })
  async me(@CurrentUser() caller: RequestContext | undefined): Promise<MeResponse> {
    const roleCodes = caller?.roleCodes ?? [];
    const { grants } = await this.permissionCache.get();

    // The union across the caller's roles: what the SPA may show.
    const permissions = new Set<string>();
    for (const roleCode of roleCodes) {
      for (const key of grants.get(roleCode)?.keys() ?? []) {
        permissions.add(key);
      }
    }

    return {
      username: caller?.username,
      userId: caller?.userId,
      roleCodes,
      jurisdictionCode: caller?.jurisdictionCode ?? 'UNKNOWN',
      permissions: [...permissions].sort(),
    };
  }

  @Get('admin/permissions')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The full permission catalogue' })
  async catalogue(): Promise<{
    routes: readonly string[];
    grants: Record<string, Record<string, number>>;
  }> {
    const { grants, routes } = await this.permissionCache.get();
    const plain: Record<string, Record<string, number>> = {};
    for (const [roleCode, perRole] of grants) {
      plain[roleCode] = Object.fromEntries(perRole);
    }
    return { routes: [...routes].sort(), grants: plain };
  }

  @Post('admin/permissions/refresh-cache')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Rebuild the authorisation catalogue from the database',
    description:
      'Run after a migration that changes permissions. Until this runs, the ' +
      'cached catalogue is served until its TTL expires.',
  })
  async refresh(): Promise<{ roles: number; routes: number }> {
    return this.permissionCache.refresh();
  }
}
