import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';

export interface MasterDataItem {
  readonly itemCode: string;
  readonly displayKey: string;
  readonly parentItemCode?: string;
  readonly sortOrder: number;
  readonly attributes?: Record<string, unknown>;
}

export interface MasterDataGroup {
  readonly groupCode: string;
  readonly jurisdictionCode?: string;
  readonly displayKey: string;
  readonly items: readonly MasterDataItem[];
}

/**
 * Jurisdiction catalogues.
 *
 * Plan reference: V2 section 6.2.
 *
 * Adjustment reasons, objection grounds, appeal forums and closure reasons all
 * share one table pair rather than getting a table each. A table per list
 * means a migration per jurisdiction, which defeats the "new jurisdiction =
 * zero code" criterion the whole design is built around.
 *
 * Effective dating is applied on read: a reason code withdrawn last year must
 * not appear in a new assessment, but must still resolve for display on a case
 * that used it at the time.
 */
@Injectable()
export class MastersService {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async listGroups(jurisdictionCode: string): Promise<readonly MasterDataGroup[]> {
    const rows = await this.sequelize.query<{
      group_code: string;
      jurisdiction_code: string | null;
      display_key: string;
    }>(
      `SELECT group_code, jurisdiction_code, display_key
         FROM platform.master_data
        WHERE is_active
          AND (jurisdiction_code IS NULL OR jurisdiction_code = :jurisdiction)
        ORDER BY group_code`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode } },
    );

    return rows.map((row) => ({
      groupCode: row.group_code,
      jurisdictionCode: row.jurisdiction_code ?? undefined,
      displayKey: row.display_key,
      items: [],
    }));
  }

  /**
   * One catalogue with its items.
   *
   * @param asOf items effective on this date. Defaults to today, so a
   *        withdrawn code disappears from new work without breaking historic
   *        cases that reference it.
   */
  async getGroup(
    groupCode: string,
    jurisdictionCode: string,
    asOf: Date = new Date(),
  ): Promise<MasterDataGroup> {
    const groups = await this.sequelize.query<{
      id: string;
      group_code: string;
      jurisdiction_code: string | null;
      display_key: string;
    }>(
      `SELECT id, group_code, jurisdiction_code, display_key
         FROM platform.master_data
        WHERE is_active
          AND group_code = :groupCode
          AND (jurisdiction_code IS NULL OR jurisdiction_code = :jurisdiction)
        ORDER BY jurisdiction_code NULLS LAST
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { groupCode, jurisdiction: jurisdictionCode },
      },
    );

    const group = groups[0];
    if (group === undefined) {
      throw new NotFoundException(`No master data group '${groupCode}'`);
    }

    const items = await this.sequelize.query<{
      item_code: string;
      display_key: string;
      parent_item_code: string | null;
      sort_order: number;
      attributes_json: Record<string, unknown> | null;
    }>(
      `SELECT i.item_code,
              i.display_key,
              p.item_code AS parent_item_code,
              i.sort_order,
              i.attributes_json
         FROM platform.master_data_item i
         LEFT JOIN platform.master_data_item p ON p.id = i.parent_item_id
        WHERE i.is_active
          AND i.master_data_id = :groupId
          AND (i.effective_from IS NULL OR i.effective_from <= :asOf)
          AND (i.effective_to   IS NULL OR i.effective_to   >= :asOf)
        ORDER BY i.sort_order, i.item_code`,
      {
        type: QueryTypes.SELECT,
        replacements: { groupId: group.id, asOf: asOf.toISOString().slice(0, 10) },
      },
    );

    return {
      groupCode: group.group_code,
      jurisdictionCode: group.jurisdiction_code ?? undefined,
      displayKey: group.display_key,
      items: items.map((item) => ({
        itemCode: item.item_code,
        displayKey: item.display_key,
        parentItemCode: item.parent_item_code ?? undefined,
        sortOrder: item.sort_order,
        attributes: item.attributes_json ?? undefined,
      })),
    };
  }
}
