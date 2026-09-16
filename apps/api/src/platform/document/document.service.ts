import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { currentCorrelationId, currentUserId, getContext } from '../auth/request-context';
import { DocumentStorage } from './document-storage';

export interface DocumentRecord {
  readonly id: number;
  readonly uuid: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly ownerType?: string;
  readonly ownerId?: number;
  readonly classification: string;
  readonly uploadedBy?: number;
  readonly createdAt: Date;
}

export interface UploadRequest {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Buffer;
  readonly ownerType?: string;
  readonly ownerId?: number;
  readonly classification?: string;
  readonly retentionClass?: string;
}

/** 25 MB. Evidence is scanned financial statements, not video. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * MIME types accepted as evidence.
 *
 * An allowlist, not a blocklist: a blocklist is a promise to have thought of
 * every dangerous type, which nobody can keep.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/**
 * Document metadata, access control and audit.
 *
 * Plan reference: V2 sections 6.3, 19.1, 20.
 *
 * The storage layer moves bytes. This layer decides what may be stored, who
 * may read it, and records that they did.
 */
@Injectable()
export class DocumentService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly storage: DocumentStorage,
  ) {}

  async upload(request: UploadRequest): Promise<DocumentRecord> {
    if (request.body.length === 0) {
      throw new BadRequestException('The uploaded file is empty');
    }
    if (request.body.length > MAX_UPLOAD_BYTES) {
      // A file size for a human-readable message, not a monetary value.
      // Rounding is for readability and nothing downstream computes on it.
      // eslint-disable-next-line no-restricted-syntax
      const megabytes = Math.round(request.body.length / 1024 / 1024);
      throw new BadRequestException(`The file is ${megabytes} MB; the limit is 25 MB`);
    }
    if (!ALLOWED_CONTENT_TYPES.has(request.contentType)) {
      throw new BadRequestException(
        `Files of type '${request.contentType}' are not accepted as evidence`,
      );
    }

    const stored = await this.storage.put(request.body, request.contentType);

    const rows = await this.sequelize.query<{ id: string; uuid: string; created_at: Date }>(
      `INSERT INTO platform.document
              (storage_key, filename, content_type, size_bytes, checksum_sha256,
               owner_type, owner_id, classification, retention_class, uploaded_by, created_by)
       VALUES (:storageKey, :filename, :contentType, :sizeBytes, :checksum,
               :ownerType, :ownerId, :classification, :retentionClass, :userId, :userId)
       RETURNING id, uuid, created_at`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          storageKey: stored.storageKey,
          filename: request.filename,
          contentType: request.contentType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksumSha256,
          ownerType: request.ownerType ?? null,
          ownerId: request.ownerId ?? null,
          classification: request.classification ?? 'TAXPAYER_CONFIDENTIAL',
          retentionClass: request.retentionClass ?? null,
          userId: currentUserId() ?? null,
        },
      },
    );

    const row = rows[0]!;
    await this.log(Number(row.id), 'UPLOAD');

    return {
      id: Number(row.id),
      uuid: row.uuid,
      filename: request.filename,
      contentType: request.contentType,
      sizeBytes: stored.sizeBytes,
      checksumSha256: stored.checksumSha256,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      classification: request.classification ?? 'TAXPAYER_CONFIDENTIAL',
      uploadedBy: currentUserId(),
      createdAt: row.created_at,
    };
  }

  async findByUuid(uuid: string): Promise<DocumentRecord> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, uuid, filename, content_type, size_bytes, checksum_sha256,
              owner_type, owner_id, classification, uploaded_by, created_at
         FROM platform.document
        WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such document');
    }
    return toRecord(row);
  }

  /** Documents belonging to one entity, e.g. every attachment on a case. */
  async listFor(ownerType: string, ownerId: number): Promise<readonly DocumentRecord[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, uuid, filename, content_type, size_bytes, checksum_sha256,
              owner_type, owner_id, classification, uploaded_by, created_at
         FROM platform.document
        WHERE owner_type = :ownerType AND owner_id = :ownerId AND is_active
        ORDER BY created_at DESC`,
      { type: QueryTypes.SELECT, replacements: { ownerType, ownerId } },
    );
    return rows.map(toRecord);
  }

  /**
   * Fetch content, verifying integrity and recording the read.
   *
   * Reads of taxpayer financial data are logged because an auditor will ask
   * who saw what (plan 19.3).
   */
  async download(uuid: string): Promise<{ record: DocumentRecord; body: Buffer }> {
    const record = await this.findByUuid(uuid);
    const storageKey = await this.storageKeyFor(record.id);
    const body = await this.storage.get(storageKey, record.checksumSha256);
    await this.log(record.id, 'DOWNLOAD');
    return { record, body };
  }

  /**
   * A short-lived URL the client fetches directly.
   *
   * The access is logged at issue rather than at fetch: the object store does
   * not report back to us, so issuing the URL is the last point we can see.
   */
  async signedUrlFor(uuid: string, expirySeconds = 300): Promise<string> {
    const record = await this.findByUuid(uuid);
    const storageKey = await this.storageKeyFor(record.id);
    await this.log(record.id, 'SIGNED_URL_ISSUED');
    return this.storage.signedUrl(storageKey, expirySeconds);
  }

  async accessHistory(
    uuid: string,
  ): Promise<Array<{ action: string; actorUserId: number | null; occurredAt: Date }>> {
    const record = await this.findByUuid(uuid);
    const rows = await this.sequelize.query<{
      action: string;
      actor_user_id: string | null;
      occurred_at: Date;
    }>(
      `SELECT action, actor_user_id, occurred_at
         FROM platform.document_access_log
        WHERE document_id = :documentId
        ORDER BY occurred_at DESC`,
      { type: QueryTypes.SELECT, replacements: { documentId: record.id } },
    );
    return rows.map((row) => ({
      action: row.action,
      actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
      occurredAt: row.occurred_at,
    }));
  }

  /** Kept private: a storage key must never reach a client (plan 20). */
  private async storageKeyFor(documentId: number): Promise<string> {
    const rows = await this.sequelize.query<{ storage_key: string }>(
      `SELECT storage_key FROM platform.document WHERE id = :documentId`,
      { type: QueryTypes.SELECT, replacements: { documentId } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such document');
    }
    return row.storage_key;
  }

  private async log(documentId: number, action: string): Promise<void> {
    const context = getContext();
    await this.sequelize.query(
      `INSERT INTO platform.document_access_log
              (document_id, action, actor_user_id, actor_role_codes, correlation_id)
       VALUES (:documentId, :action, :userId, CAST(:roles AS jsonb), :correlationId)`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          documentId,
          action,
          userId: currentUserId() ?? null,
          roles: JSON.stringify(context?.roleCodes ?? []),
          correlationId: currentCorrelationId() ?? null,
        },
      },
    );
  }
}

function toRecord(row: Record<string, unknown>): DocumentRecord {
  return {
    id: Number(row['id']),
    uuid: String(row['uuid']),
    filename: String(row['filename']),
    contentType: String(row['content_type']),
    sizeBytes: Number(row['size_bytes']),
    checksumSha256: String(row['checksum_sha256']),
    ownerType: row['owner_type'] === null ? undefined : String(row['owner_type']),
    ownerId: row['owner_id'] === null ? undefined : Number(row['owner_id']),
    classification: String(row['classification']),
    uploadedBy: row['uploaded_by'] === null ? undefined : Number(row['uploaded_by']),
    createdAt: row['created_at'] as Date,
  };
}

export { MAX_UPLOAD_BYTES, ALLOWED_CONTENT_TYPES };
