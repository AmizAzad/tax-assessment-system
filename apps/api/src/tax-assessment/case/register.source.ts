import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { GridService } from '../../platform/grid/grid.service';
import type {
  GridCaller,
  GridPage,
  GridQuery,
  GridSort,
  GridSource,
} from '../../platform/grid/grid.model';
import { registerScopeClause } from './register-scope';

/**
 * The assessment register, as a configurable grid.
 *
 * Plan reference: V2 sections 6.8, 18.1 screen 3.
 *
 * ## The allowlist is the security boundary
 *
 * `SORTABLE` maps a column key to the SQL that produces it. A key absent from
 * this map cannot be selected, cannot be sorted on and cannot be exported,
 * whatever a grid definition in the database says. That inversion is the
 * point: configuration chooses *from* what the code offers, and can never
 * add to it. Register columns are then safe to edit from an administration
 * screen, because the worst a bad definition achieves is an error.
 *
 * ## Why money is cast to text here
 *
 * `numeric(20,4)` comes back from the driver as a string already, but the
 * cast makes it explicit and survives a column type change. Nothing between
 * this query and the officer's screen turns it into a double (ADR-007).
 */

/** Column key to the SQL expression that produces it. The allowlist. */
const SORTABLE: Readonly<Record<string, string>> = {
  id: 'c.id',
  uuid: 'c.uuid',
  caseNumber: 'c.case_number',
  taxpayerName: 'c.taxpayer_name',
  tin: 'c.tin',
  taxTypeCode: 'c.tax_type_code',
  jurisdictionCode: 'c.jurisdiction_code',
  assessmentYear: 'c.assessment_year',
  assessmentType: 'c.assessment_type',
  triggerPath: 'c.trigger_path',
  statusCode: 'c.status_code',
  liabilityStatus: 'c.liability_status',
  currencyCode: 'c.currency_code',
  netPayable: 'c.net_payable',
  assessedBase: 'c.assessed_base',
  limitationDate: 'c.limitation_date',
  openedAt: 'c.opened_at',
  finalisedAt: 'c.finalised_at',
};

/** Columns whose values are money and must reach the client as text. */
const MONEY_COLUMNS = new Set(['netPayable', 'assessedBase']);

@Injectable()
export class RegisterGridSource implements GridSource, OnModuleInit {
  readonly gridKey = 'ASSESSMENT_REGISTER';
  readonly sortable = SORTABLE;

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly grids: GridService,
  ) {}

  onModuleInit(): void {
    // Published into the platform registry at boot. The platform cannot
    // import this file (plan 14.2), so the dependency points this way.
    this.grids.register(this);
  }

  async page(caller: GridCaller, query: GridQuery): Promise<GridPage> {
    const { where, replacements } = this.predicate(caller, query.filters);

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT ${this.projection()}
         FROM tax.tax_assessment_case c
        WHERE ${where}
        ORDER BY ${this.orderBy(query.sort)}
        LIMIT :limit OFFSET :offset`,
      {
        type: QueryTypes.SELECT,
        replacements: { ...replacements, limit: query.limit, offset: query.offset },
      },
    );

    const counted = await this.sequelize.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM tax.tax_assessment_case c WHERE ${where}`,
      { type: QueryTypes.SELECT, replacements },
    );

    return { rows, total: Number(counted[0]?.total ?? 0) };
  }

  /**
   * Every matching row, in batches.
   *
   * Keyset pagination on `c.id` rather than OFFSET. An export of a large
   * register with OFFSET makes the database re-scan and discard an ever
   * longer prefix — the last batch of a 500,000-row export costs 500,000
   * rows of work — and it silently skips or repeats rows if a case is opened
   * while the export runs. A cursor on the primary key has neither problem.
   *
   * The trade is that the export is ordered by id rather than by the
   * requested sort. That is the right way round: a file is sorted by whoever
   * opens it, and correctness of the row set matters more than its order.
   */
  async *stream(
    caller: GridCaller,
    filters: GridQuery['filters'],
    _sort: GridSort | undefined,
    batchSize: number,
  ): AsyncGenerator<readonly Record<string, unknown>[]> {
    const { where, replacements } = this.predicate(caller, filters);
    let after = 0;

    for (;;) {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `SELECT ${this.projection()}
           FROM tax.tax_assessment_case c
          WHERE ${where} AND c.id > :after
          ORDER BY c.id
          LIMIT :limit`,
        {
          type: QueryTypes.SELECT,
          replacements: { ...replacements, after, limit: batchSize },
        },
      );

      if (rows.length === 0) {
        return;
      }

      yield rows;
      after = Number(rows[rows.length - 1]!['id']);
    }
  }

  // ---------------------------------------------------------------- internals

  private projection(): string {
    return Object.entries(SORTABLE)
      .map(([key, expression]) => {
        const value = MONEY_COLUMNS.has(key) ? `${expression}::text` : expression;
        return `${value} AS "${key}"`;
      })
      .join(', ');
  }

  private orderBy(sort: GridSort | undefined): string {
    if (sort === undefined) {
      return 'c.opened_at DESC, c.id DESC';
    }
    // `sort.key` has already been checked against this allowlist by
    // GridService.resolveSort, and the direction is one of two literals.
    // Neither reaches SQL as caller-supplied text.
    const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
    return `${SORTABLE[sort.key]} ${direction}, c.id DESC`;
  }

  private predicate(
    caller: GridCaller,
    filters: GridQuery['filters'],
  ): { where: string; replacements: Record<string, unknown> } {
    const where = `
      c.is_active
      AND ${registerScopeClause(caller.roleCodes)}
      AND (:status::text IS NULL OR c.status_code = :status)
      AND (:taxTypeCode::text IS NULL OR c.tax_type_code = :taxTypeCode)
      AND (:jurisdiction::text IS NULL OR c.jurisdiction_code = :jurisdiction)
      AND (:assessmentYear::text IS NULL OR c.assessment_year = :assessmentYear)
      AND (:taxpayerId::bigint IS NULL OR c.taxpayer_id = :taxpayerId)
      AND (:openedFrom::date IS NULL OR c.opened_at >= :openedFrom)
      AND (:openedTo::date IS NULL OR c.opened_at < (:openedTo::date + 1))
      AND (:search::text IS NULL
           OR c.case_number ILIKE '%' || :search || '%'
           OR c.taxpayer_name ILIKE '%' || :search || '%'
           OR c.tin ILIKE '%' || :search || '%')`;

    return {
      where,
      replacements: {
        callerId: caller.userId,
        status: text(filters['status']),
        taxTypeCode: text(filters['taxTypeCode']),
        jurisdiction: text(filters['jurisdiction']),
        assessmentYear: text(filters['assessmentYear']),
        taxpayerId: filters['taxpayerId'] === undefined ? null : Number(filters['taxpayerId']),
        openedFrom: text(filters['openedFrom']),
        openedTo: text(filters['openedTo']),
        search: text(filters['search']),
      },
    };
  }
}

/** Empty string means "no filter", which is what a cleared select box sends. */
function text(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value);
}
