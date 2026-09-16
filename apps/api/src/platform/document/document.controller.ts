import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators';
import { PermissionLevel } from '../authorization/permission.model';
import { DocumentService, type DocumentRecord } from './document.service';

/**
 * Document metadata and access.
 *
 * Note what is absent: an endpoint returning a storage key. Clients get a
 * short-lived signed URL instead, so access is time-boxed and a leaked link
 * stops working (plan section 20).
 *
 * Upload arrives with the submission it belongs to in Phase 2; this surface is
 * read-only for now.
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Get(':uuid')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Document metadata' })
  async find(@Param('uuid') uuid: string): Promise<DocumentRecord> {
    return this.documents.findByUuid(uuid);
  }

  @Get(':uuid/url')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'A short-lived download URL' })
  async signedUrl(
    @Param('uuid') uuid: string,
    @Query('expirySeconds') expirySeconds?: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    // Capped: a URL that outlives the session it was issued for is a liability.
    const requested = Number(expirySeconds ?? 300);
    const expiry = Number.isFinite(requested) ? Math.min(Math.max(requested, 30), 900) : 300;
    return {
      url: await this.documents.signedUrlFor(uuid, expiry),
      expiresInSeconds: expiry,
    };
  }

  @Get(':uuid/access-history')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Who has read this document' })
  async accessHistory(@Param('uuid') uuid: string) {
    return this.documents.accessHistory(uuid);
  }
}
