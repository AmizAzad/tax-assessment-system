import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import type { RequestContext } from '../auth/request-context';
import { PermissionLevel } from '../authorization/permission.model';
import { CreateExportDto } from './export.dto';
import { ExportService } from './export.service';

@ApiTags('exports')
@Controller('exports')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  /**
   * Ask for an export.
   *
   * Rate limited harder than an ordinary read. An export is the cheapest way
   * to take a copy of the register, and a compromised officer account with no
   * limit here is a bulk extraction tool.
   */
  @Post()
  @RequirePermission(PermissionLevel.EDIT)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Export a register as CSV or XLSX',
    description:
      'Small exports come back READY and can be collected at once. Larger ones are queued and ' +
      'produced by the worker, because holding a request open for the length of a ' +
      'million-row query is how an export becomes a timeout the officer retries.',
  })
  async create(@Body() body: CreateExportDto, @CurrentUser() caller: RequestContext | undefined) {
    return this.exports.request(caller!, body.gridKey, body.filters ?? {}, body.format, body.sort);
  }

  @Get()
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'My recent exports' })
  async mine(@CurrentUser() caller: RequestContext | undefined) {
    return this.exports.mine(caller!);
  }

  @Get(':uuid')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Whether an export is ready' })
  async status(@Param('uuid') uuid: string) {
    return this.exports.status(uuid);
  }

  @Get(':uuid/download')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Collect a finished export',
    description:
      'Only the officer who requested it. The file carries that officer’s scope, so handing ' +
      'it to another caller would hand them the first one’s access.',
  })
  async download(
    @Param('uuid') uuid: string,
    @CurrentUser() caller: RequestContext | undefined,
    @Res()
    response: { setHeader: (key: string, value: string) => void; send: (body: Buffer) => void },
  ): Promise<void> {
    const file = await this.exports.download(caller!, uuid);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    response.send(file.body);
  }
}
