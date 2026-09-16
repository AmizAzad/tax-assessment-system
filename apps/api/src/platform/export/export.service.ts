import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../auth/request-context';
import { DocumentService } from '../document/document.service';
import { GridService } from '../grid/grid.service';
import type { GridCaller, GridColumn, GridSource } from '../grid/grid.model';
import { csvHeader, csvRow, writeXlsx } from './export-writer';

export type ExportFormat = 'CSV' | 'XLSX';

export interface ExportJob {
  readonly uuid: string;
  readonly gridKey: string;
  readonly format: ExportFormat;
  readonly status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';
  readonly rowCount: number | null;
  readonly errorDetail: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
}

/**
 * The row count above which an export is produced by the worker instead of
 * in the request.
 *
 * Chosen from what the request can finish inside a normal proxy timeout
 * rather than from a benchmark: 5,000 rows of the assessment register is
 * about a megabyte and well under a second, and a register of that size is
 * what an officer filtering down to their own work actually asks for. The
 * unfiltered register — hundreds of thousands of rows — is the case this
 * threshold exists to keep out of the request path.
 */
const INLINE_ROW_LIMIT = 5_000;

/** Rows fetched per round trip while building a file. */
const BATCH_SIZE = 1_000;

/**
 * Register exports.
 *
 * Plan reference: V2 section 6.8 ("CSV and XLSX export per grid key,
 * generated asynchronously above a row threshold"), section 19.1 (access to
 * taxpayer data is auditable).
 *
 * ## Why every export is a row, even the instant ones
 *
 * A small export could stream straight back and leave no trace. It does not,
 * because the question an auditor asks about an export is never "was it
 * slow" — it is "who took a copy of the register, when, and filtered to
 * what". One code path, one audit trail, and the client always collects the
 * file the same way.
 *
 * ## Why the caller's scope is stored with the job
 *
 * A queued export is produced later by a process with no request in flight.
 * If the worker exported everything the query matched, an assessor's export
 * would contain the whole register — a privilege escalation with a
 * spreadsheet on the end of it. So the requester's identity and roles are
 * recorded on the job and re-applied when it runs.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly grids: GridService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * Ask for an export.
   *
   * Returns the job. Small ones come back `READY` and can be collected
   * immediately; large ones come back `QUEUED` and the worker picks them up.
   */
  async request(
    caller: RequestContext,
    gridKey: string,
    filters: Record<string, string | number | undefined>,
    format: ExportFormat,
    sort?: string,
  ): Promise<ExportJob> {
    if (caller.userId === undefined) {
      // An export has to be attributable. There is no legitimate path here
      // without an identified caller.
      throw new ForbiddenException('An export must be attributable to a user');
    }

    const source = this.grids.source(gridKey);
    const resolvedSort = this.grids.resolveSort(source, sort);

    // One cheap count decides the route. `limit: 1` because the page is
    // discarded; only the total matters.
    const { total } = await source.page(callerOf(caller), {
      filters,
      sort: resolvedSort,
      limit: 1,
      offset: 0,
    });

    const job = await this.insert(caller, gridKey, format, filters, sort);

    if (total <= INLINE_ROW_LIMIT) {
      return this.produce(job.uuid);
    }

    this.logger.log(
      `Export ${job.uuid} queued: ${total} rows of ${gridKey} exceeds the inline limit ` +
        `of ${INLINE_ROW_LIMIT}`,
    );
    return job;
  }

  /**
   * Build the file for one job.
   *
   * Called in the request for a small export and by the worker for a large
   * one. Identical either way — the only difference is who is waiting.
   */
  async produce(uuid: string): Promise<ExportJob> {
    const row = await this.row(uuid);

    await this.sequelize.query(
      `UPDATE platform.export_job
          SET status = 'RUNNING', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE uuid = :uuid AND status = 'QUEUED'`,
      { type: QueryTypes.UPDATE, replacements: { uuid } },
    );

    try {
      const gridKey = String(row['grid_key']);
      const format = String(row['format']) as ExportFormat;
      const source = this.grids.source(gridKey);
      const definition = await this.grids.definition(gridKey);
      const columns = definition.columns;

      const caller: GridCaller = {
        userId: Number(row['requested_by']),
        roleCodes: String(row['requested_role_codes']).split(',').filter(Boolean),
      };
      // The sort travels inside the stored filters and is separated again
      // here, so the source is handed filters it recognises and nothing else.
      const stored = (row['filters_json'] ?? {}) as Record<string, string | number | undefined>;
      const { sort: storedSort, ...filters } = stored;
      const sort = this.grids.resolveSort(
        source,
        typeof storedSort === 'string' ? storedSort : undefined,
      );

      const { body, rowCount, contentType, extension } = await this.render(
        source,
        caller,
        columns,
        filters,
        sort,
        format,
        gridKey,
      );

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const document = await this.documents.upload({
        filename: `${gridKey.toLowerCase()}-${stamp}.${extension}`,
        contentType,
        body,
        ownerType: 'EXPORT_JOB',
        ownerId: Number(row['id']),
        // An export of the register is taxpayer financial data, whatever the
        // file extension says.
        classification: 'TAXPAYER_CONFIDENTIAL',
      });

      await this.sequelize.query(
        `UPDATE platform.export_job
            SET status = 'READY', row_count = :rowCount, document_id = :documentId,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE uuid = :uuid`,
        {
          type: QueryTypes.UPDATE,
          replacements: { uuid, rowCount, documentId: document.id },
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Export ${uuid} failed: ${detail}`);
      await this.sequelize.query(
        `UPDATE platform.export_job
            SET status = 'FAILED', error_detail = :detail,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE uuid = :uuid`,
        { type: QueryTypes.UPDATE, replacements: { uuid, detail: detail.slice(0, 1000) } },
      );
    }

    return this.status(uuid);
  }

  /** One job's state. */
  async status(uuid: string): Promise<ExportJob> {
    return toJob(await this.row(uuid));
  }

  /** The caller's own recent exports, newest first. */
  async mine(caller: RequestContext): Promise<readonly ExportJob[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT uuid, grid_key, format, status, row_count, error_detail, requested_at, completed_at
         FROM platform.export_job
        WHERE requested_by = :userId AND is_active
        ORDER BY requested_at DESC
        LIMIT 25`,
      { type: QueryTypes.SELECT, replacements: { userId: caller.userId ?? -1 } },
    );
    return rows.map(toJob);
  }

  /**
   * Collect a finished export.
   *
   * Only the officer who asked for it. An export carries whatever scope its
   * requester had, so handing it to a second caller would hand them the first
   * caller's access.
   */
  async download(
    caller: RequestContext,
    uuid: string,
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const row = await this.row(uuid);

    if (Number(row['requested_by']) !== (caller.userId ?? -1)) {
      // 404 rather than 403: the existence of somebody else's export is not
      // this caller's business.
      throw new NotFoundException('No such export');
    }
    if (String(row['status']) !== 'READY') {
      throw new NotFoundException(`This export is ${String(row['status']).toLowerCase()}`);
    }

    const documentId = Number(row['document_id']);
    const uuidRows = await this.sequelize.query<{ uuid: string }>(
      `SELECT uuid FROM platform.document WHERE id = :id AND is_active`,
      { type: QueryTypes.SELECT, replacements: { id: documentId } },
    );
    const documentUuid = uuidRows[0]?.uuid;
    if (documentUuid === undefined) {
      throw new NotFoundException('The exported file is no longer available');
    }

    const { record, body } = await this.documents.download(documentUuid);
    return { filename: record.filename, contentType: record.contentType, body };
  }

  /**
   * Claim and run queued jobs.
   *
   * Called by the worker. Claims one at a time with `FOR UPDATE SKIP LOCKED`
   * so several replicas can drain the queue without two of them building the
   * same file.
   */
  async runQueued(maximum = 5): Promise<number> {
    let produced = 0;

    for (let index = 0; index < maximum; index += 1) {
      const claimed = await this.sequelize.transaction(async (transaction) => {
        const rows = await this.sequelize.query<{ uuid: string }>(
          `SELECT uuid FROM platform.export_job
            WHERE status = 'QUEUED' AND is_active
            ORDER BY requested_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          { type: QueryTypes.SELECT, transaction },
        );
        return rows[0]?.uuid;
      });

      if (claimed === undefined) {
        break;
      }

      await this.produce(claimed);
      produced += 1;
    }

    return produced;
  }

  // ---------------------------------------------------------------- internals

  private async render(
    source: GridSource,
    caller: GridCaller,
    columns: readonly GridColumn[],
    filters: Record<string, string | number | undefined>,
    sort: ReturnType<GridService['resolveSort']>,
    format: ExportFormat,
    gridKey: string,
  ): Promise<{ body: Buffer; rowCount: number; contentType: string; extension: string }> {
    const batches = source.stream(caller, filters, sort, BATCH_SIZE);

    if (format === 'XLSX') {
      const { body, rowCount } = await writeXlsx(gridKey, columns, batches);
      return {
        body,
        rowCount,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
    }

    const lines: string[] = [csvHeader(columns)];
    let rowCount = 0;
    for await (const batch of batches) {
      for (const row of batch) {
        lines.push(csvRow(columns, row));
        rowCount += 1;
      }
    }

    // A BOM, so Excel opens a UTF-8 CSV as UTF-8. Without it an Arabic
    // taxpayer name arrives as mojibake and the officer reports a data
    // problem that is really a file-encoding one.
    const body = Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
    return { body, rowCount, contentType: 'text/csv', extension: 'csv' };
  }

  private async insert(
    caller: RequestContext,
    gridKey: string,
    format: ExportFormat,
    filters: Record<string, string | number | undefined>,
    sort: string | undefined,
  ): Promise<ExportJob> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO platform.export_job
              (grid_key, format, filters_json, requested_by, requested_role_codes,
               status, created_by, updated_by)
       VALUES (:gridKey, :format, CAST(:filters AS jsonb), :userId, :roles,
               'QUEUED', :userId, :userId)
       RETURNING uuid, grid_key, format, status, row_count, error_detail,
                 requested_at, completed_at`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          gridKey,
          format,
          filters: JSON.stringify(sort === undefined ? filters : { ...filters, sort }),
          userId: caller.userId,
          roles: caller.roleCodes.join(','),
        },
      },
    );
    return toJob(rows[0]!);
  }

  private async row(uuid: string): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM platform.export_job WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such export');
    }
    return row;
  }
}

function callerOf(caller: RequestContext): GridCaller {
  return { userId: caller.userId ?? -1, roleCodes: caller.roleCodes };
}

function toJob(row: Record<string, unknown>): ExportJob {
  return {
    uuid: String(row['uuid']),
    gridKey: String(row['grid_key']),
    format: String(row['format']) as ExportFormat,
    status: String(row['status']) as ExportJob['status'],
    rowCount: row['row_count'] === null ? null : Number(row['row_count']),
    errorDetail: row['error_detail'] === null ? null : String(row['error_detail']),
    requestedAt: row['requested_at'] as Date,
    completedAt: row['completed_at'] === null ? null : (row['completed_at'] as Date),
  };
}
