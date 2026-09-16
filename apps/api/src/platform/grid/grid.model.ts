/**
 * Configurable registers.
 *
 * Plan reference: V2 section 6.8, section 18.1 screen 3, section 21.1.
 *
 * ## The shape of the contract, and the one thing it will not carry
 *
 * A grid definition is data: a key, a label, a rendering type, whether it may
 * be sorted, whether it appears on screen or only in an export. It never
 * carries a SQL fragment. The server holds a fixed map from column key to SQL
 * expression, and a key that is not in that map is refused.
 *
 * That split is the whole design. Without it, register configuration becomes
 * an injection route with an administration screen in front of it, and
 * "only an administrator can edit it" is not a defence — an administrator
 * account is precisely what an attacker works towards.
 */

/** How the browser should render a column. */
export type GridColumnType =
  'text' | 'amount' | 'date' | 'datetime' | 'status' | 'link' | 'taxpayer';

export interface GridColumn {
  /** Resolved against the source's allowlist. Never a SQL expression. */
  readonly key: string;
  readonly label: string;
  readonly type: GridColumnType;
  readonly sortable?: boolean;
  readonly align?: 'start' | 'end';
  /** In the export only. Keeps a working register readable without losing detail. */
  readonly exportOnly?: boolean;
}

export interface GridDefinition {
  readonly gridKey: string;
  readonly columns: readonly GridColumn[];
  /** `key:asc` or `key:desc`. Applied when the caller asks for no order. */
  readonly defaultSort: string | null;
}

/** A parsed, validated sort instruction. */
export interface GridSort {
  readonly key: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * Who is asking.
 *
 * Carried explicitly rather than read from the request store, because an
 * export runs later in a worker with no request in flight and must still
 * apply the scope of the officer who asked for it.
 */
export interface GridCaller {
  readonly userId: number;
  readonly roleCodes: readonly string[];
}

export interface GridQuery {
  readonly filters: Readonly<Record<string, string | number | undefined>>;
  readonly sort?: GridSort;
  readonly limit: number;
  readonly offset: number;
}

export interface GridPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
}

/**
 * A register the platform can list and export.
 *
 * Implemented by the domain — the platform has no idea what an assessment is
 * — and registered here so that the grid and export machinery stays
 * domain-agnostic (plan section 14.2 forbids the other direction).
 */
export interface GridSource {
  readonly gridKey: string;

  /**
   * Column key to SQL expression.
   *
   * The allowlist. Anything absent from this map cannot be sorted on and
   * cannot be exported, whatever a grid definition says.
   */
  readonly sortable: Readonly<Record<string, string>>;

  /** One page, already scoped to the caller. */
  page(caller: GridCaller, query: GridQuery): Promise<GridPage>;

  /**
   * Every matching row, for an export.
   *
   * Yields in batches so a million-row register does not become a
   * million-row array. The caller writes each batch out and forgets it.
   */
  stream(
    caller: GridCaller,
    filters: GridQuery['filters'],
    sort: GridSort | undefined,
    batchSize: number,
  ): AsyncGenerator<readonly Record<string, unknown>[]>;
}
