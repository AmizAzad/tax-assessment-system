import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import type { RequestContext } from '../auth/request-context';
import { PermissionLevel } from '../authorization/permission.model';
import { MastersService, type MasterDataGroup } from './masters.service';

@ApiTags('masters')
@Controller('masters')
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @Get()
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'List master data groups for the caller jurisdiction' })
  async list(
    @CurrentUser() caller: RequestContext | undefined,
  ): Promise<readonly MasterDataGroup[]> {
    return this.masters.listGroups(caller?.jurisdictionCode ?? 'GB');
  }

  @Get(':groupCode')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'One master data group with its effective items' })
  async getGroup(
    @Param('groupCode') groupCode: string,
    @CurrentUser() caller: RequestContext | undefined,
  ): Promise<MasterDataGroup> {
    return this.masters.getGroup(groupCode, caller?.jurisdictionCode ?? 'GB');
  }
}
