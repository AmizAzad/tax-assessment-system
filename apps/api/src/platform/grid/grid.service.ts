import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { GridColumn, GridDefinition, GridSort, GridSource } from './grid.model';

/**
 * Register definitions and the sources that fill them.
 *
 * Plan reference: V2 section 6.8.
 *
 * ## Why the registry is here and not a module import
 *
 * `platform` may not import from `tax-assessment` (plan 14.2, enforced by
 * lint). The domain therefore pushes its sources in at boot, and this service
 * knows only that something implements `GridSource`. The rule earns its keep
 * here: the grid machinery is reusable by any domain built on this platform,
 * because it cannot name one.
 */
@Injectable()
export class GridService {
  private readonly sources = new Map<string, GridSource>();

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Called by the owning domain module during initialisation. */
  register(source: GridSource): void {
    this.sources.set(source.gridKey, source);
  }

  source(gridKey: string): GridSource {
    const source = this.sources.get(gridKey);
    if (source === undefined) {
      throw new NotFoundException(`No register is published under the key '${gridKey}'`);
    }
    return source;
  }

  /**
   * The configured columns.
   *
   * Read on every request rather than cached: a column change is a
   * configuration change and should take effect when it is saved, not when
   * somebody remembers to restart the API. The row is tiny and the query is
   * a primary-key lookup.
   */
  async definition(gridKey: string): Promise<GridDefinition> {
    const rows = await this.sequelize.query<{
      grid_key: string;
      column_defs: unknown;
      default_sort: string | null;
    }>(
      `SELECT grid_key, column_defs, default_sort
         FROM platform.grid_definition
        WHERE grid_key = :gridKey AND is_active`,
      { type: QueryTypes.SELECT, replacements: { gridKey } },
    );

    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`No grid definition for '${gridKey}'`);
    }

    const columns = this.parseColumns(gridKey, row.column_defs);

    // A definition naming a column the source cannot produce is a
    // configuration error, and it should surface when the grid is read rather
    // than as an empty column nobody can explain.
    const source = this.sources.get(gridKey);
    if (source !== undefined) {
      const unknown = columns.filter((column) => !(column.key in source.sortable));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Grid '${gridKey}' is configured with columns this register cannot supply: ` +
            unknown.map((column) => column.key).join(', '),
        );
      }
    }

    return { gridKey: row.grid_key, columns, defaultSort: row.default_sort };
  }

  /**
   * Parse and validate a sort instruction.
   *
   * The key is checked against the source's allowlist, so a caller cannot
   * append SQL through the `sort` query parameter. The direction is one of
   * two literals, never interpolated from input.
   */
  resolveSort(source: GridSource, requested: string | undefined): GridSort | undefined {
    if (requested === undefined || requested.trim() === '') {
      return undefined;
    }

    const [key, direction = 'asc'] = requested.split(':');
    if (key === undefined || !(key in source.sortable)) {
      throw new BadRequestException(
        `'${key}' is not a column this register can be sorted by. ` +
          `Sortable: ${Object.keys(source.sortable).sort().join(', ')}`,
      );
    }
    if (direction !== 'asc' && direction !== 'desc') {
      throw new BadRequestException(`Sort direction must be 'asc' or 'desc', not '${direction}'`);
    }
    return { key, direction };
  }

  private parseColumns(gridKey: string, raw: unknown): readonly GridColumn[] {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new BadRequestException(`Grid '${gridKey}' has no columns configured`);
    }

    return parsed.map((entry) => {
      const column = entry as Partial<GridColumn>;
      if (typeof column.key !== 'string' || typeof column.label !== 'string') {
        throw new BadRequestException(
          `Grid '${gridKey}' has a column without a key or a label. ` +
            'Every column needs both: one addresses the data, the other is what an officer reads.',
        );
      }
      return {
        key: column.key,
        label: column.label,
        type: column.type ?? 'text',
        sortable: column.sortable ?? false,
        align: column.align,
        exportOnly: column.exportOnly ?? false,
      };
    });
  }
}
