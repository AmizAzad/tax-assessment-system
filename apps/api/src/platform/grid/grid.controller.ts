import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators';
import { PermissionLevel } from '../authorization/permission.model';
import { GridService } from './grid.service';

@ApiTags('grids')
@Controller('grids')
export class GridController {
  constructor(private readonly grids: GridService) {}

  @Get(':key')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'The configured columns of a register',
    description:
      'Columns are configuration, so the browser asks what to render rather than deciding. ' +
      'A deployment that wants the limitation date on every officer’s register changes a row, ' +
      'not a component.',
  })
  async definition(@Param('key') key: string) {
    return this.grids.definition(key);
  }
}
