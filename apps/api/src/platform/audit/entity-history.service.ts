import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { currentCorrelationId, currentUserId } from '../auth/request-context';

export type HistoryOperation = 'INSERT' | 'UPDATE' | 'DELETE';

export interface HistoryRecord {
  readonly schemaName: string;
  readonly tableName: string;
  readonly recordId: number;
  readonly operation: HistoryOperation;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
}

/**
 * Generic before/after snapshots for registered tables.
 *
 * Plan reference: V2 sections 6.5, 19.1, 19.2.
 *
 * Which tables are audited is a configuration row in
 * `platform.entity_history_config`, not a bespoke trigger per table. Adding
 * audit to a new table is therefore a seed, not a migration full of SQL.
 *
 * ## What this is and is not
 *
 * This is the *field-level* audit: what changed, from what, to what. It is not
 * the domain audit. Domain events -- a calculation run, a notice served, a
 * deadline breached -- go to `tax.tax_assessment_event`, which is the audit
 * system of record (plan 19.2). The two answer different questions: this one
 * answers "who changed this field", the ledger answers "what happened to this
 * case".
 *
 * ## Attribution
 *
 * The actor comes from the request context rather than being passed in, so a
 * caller cannot accidentally attribute a change to the wrong user. Background
 * work runs under a SYSTEM context and is attributed accordingly.
 */
@Injectable()
export class EntityHistoryService implements OnModuleInit {
  private readonly logger = new Logger(EntityHistoryService.name);

  /** `schema.table` -> columns never snapshotted. */
  private registry = new Map<string, ReadonlySet<string>>();

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleInit(): Promise<void> {
    await this.loadRegistry();
  }

  async loadRegistry(): Promise<number> {
    const rows = await this.sequelize.query<{
      schema_name: string;
      table_name: string;
      excluded_columns: string[] | null;
    }>(
      `SELECT schema_name, table_name, excluded_columns
         FROM platform.entity_history_config
        WHERE is_active`,
      { type: QueryTypes.SELECT },
    );

    this.registry = new Map(
      rows.map((row) => [
        `${row.schema_name}.${row.table_name}`,
        new Set(row.excluded_columns ?? []),
      ]),
    );
    this.logger.log(`Entity history registered for ${this.registry.size} tables`);
    return this.registry.size;
  }

  isRegistered(schemaName: string, tableName: string): boolean {
    return this.registry.has(`${schemaName}.${tableName}`);
  }

  /**
   * Record a change.
   *
   * Silently ignores unregistered tables: registration is the opt-in, and a
   * caller should not have to check first.
   *
   * A failure here is logged, never thrown. An audit write that breaks the
   * business transaction would be worse than a missing audit row -- but the
   * log line is the signal that something needs fixing.
   */
  async record(change: HistoryRecord): Promise<void> {
    const excluded = this.registry.get(`${change.schemaName}.${change.tableName}`);
    if (excluded === undefined) {
      return;
    }

    const before = redact(change.before, excluded);
    const after = redact(change.after, excluded);
    const changedColumns = diffKeys(before, after);

    // An UPDATE that changed nothing is noise. INSERT and DELETE are always
    // worth recording even though one side is empty.
    if (change.operation === 'UPDATE' && changedColumns.length === 0) {
      return;
    }

    try {
      await this.sequelize.query(
        `INSERT INTO platform.entity_history
                (schema_name, table_name, record_id, operation,
                 before_json, after_json, changed_columns,
                 actor_user_id, correlation_id)
         VALUES (:schemaName, :tableName, :recordId, :operation,
                 :before, :after, :changedColumns,
                 :actorUserId, :correlationId)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            schemaName: change.schemaName,
            tableName: change.tableName,
            recordId: change.recordId,
            operation: change.operation,
            before: before === undefined ? null : JSON.stringify(before),
            after: after === undefined ? null : JSON.stringify(after),
            changedColumns: JSON.stringify(changedColumns),
            actorUserId: currentUserId() ?? null,
            correlationId: currentCorrelationId() ?? null,
          },
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to write entity history for ${change.schemaName}.${change.tableName}` +
          `#${change.recordId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** The change history for one record, newest first. */
  async historyFor(
    schemaName: string,
    tableName: string,
    recordId: number,
  ): Promise<
    Array<{
      operation: HistoryOperation;
      changedColumns: string[];
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      actorUserId: number | null;
      occurredAt: Date;
    }>
  > {
    const rows = await this.sequelize.query<{
      operation: HistoryOperation;
      changed_columns: string[] | null;
      before_json: Record<string, unknown> | null;
      after_json: Record<string, unknown> | null;
      actor_user_id: string | null;
      occurred_at: Date;
    }>(
      `SELECT operation, changed_columns, before_json, after_json,
              actor_user_id, occurred_at
         FROM platform.entity_history
        WHERE schema_name = :schemaName
          AND table_name  = :tableName
          AND record_id   = :recordId
        ORDER BY occurred_at DESC, id DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { schemaName, tableName, recordId },
      },
    );

    return rows.map((row) => ({
      operation: row.operation,
      changedColumns: row.changed_columns ?? [],
      before: row.before_json,
      after: row.after_json,
      actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
      occurredAt: row.occurred_at,
    }));
  }
}

function redact(
  row: Record<string, unknown> | undefined,
  excluded: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (row === undefined) return undefined;
  if (excluded.size === 0) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key)));
}

/** Columns whose value differs between the two snapshots. */
function diffKeys(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (before === undefined || after === undefined) {
    return Object.keys(after ?? before ?? {});
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !sameValue(before[key], after[key])).sort();
}

/**
 * Value comparison for audit purposes.
 *
 * Dates compare by instant, not identity. Everything else compares by JSON
 * shape, which is sufficient for row values and avoids a deep-equality
 * dependency.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (left === null || right === null || left === undefined || right === undefined) {
    return false;
  }
  if (typeof left === 'object' && typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}
