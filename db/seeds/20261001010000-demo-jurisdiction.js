'use strict';

/**
 * A demo jurisdiction (GB) with enough reference data to exercise the system.
 *
 * Plan reference: V2 section 26.3 -- synthetic, reproducible, and never real
 * taxpayer data. This is a seed, not a migration, so it is applied to
 * development and test environments only.
 */

const JURISDICTION = 'GB';

const CATALOGUES = [
  {
    groupCode: 'ADJUSTMENT_TYPE',
    displayKey: 'ta.master.adjustmentType',
    items: [
      ['STATUTORY_DISALLOWANCE', 'ta.master.adjustmentType.statutoryDisallowance'],
      ['UNDERSTATED_REVENUE', 'ta.master.adjustmentType.understatedRevenue'],
      ['OVERSTATED_EXPENSE', 'ta.master.adjustmentType.overstatedExpense'],
      ['TIMING_DIFFERENCE', 'ta.master.adjustmentType.timingDifference'],
      ['TRANSFER_PRICING', 'ta.master.adjustmentType.transferPricing'],
    ],
  },
  {
    groupCode: 'ADJUSTMENT_REASON',
    displayKey: 'ta.master.adjustmentReason',
    items: [
      ['NO_SUPPORTING_EVIDENCE', 'ta.master.adjustmentReason.noSupportingEvidence'],
      ['NOT_WHOLLY_EXCLUSIVELY', 'ta.master.adjustmentReason.notWhollyExclusively'],
      ['CAPITAL_IN_NATURE', 'ta.master.adjustmentReason.capitalInNature'],
      ['ARITHMETIC_ERROR', 'ta.master.adjustmentReason.arithmeticError'],
      ['THIRD_PARTY_MISMATCH', 'ta.master.adjustmentReason.thirdPartyMismatch'],
    ],
  },
  {
    groupCode: 'OBJECTION_GROUND',
    displayKey: 'ta.master.objectionGround',
    items: [
      ['FACTUAL_ERROR', 'ta.master.objectionGround.factualError'],
      ['LEGAL_INTERPRETATION', 'ta.master.objectionGround.legalInterpretation'],
      ['PROCEDURAL_IRREGULARITY', 'ta.master.objectionGround.proceduralIrregularity'],
      ['NEW_EVIDENCE', 'ta.master.objectionGround.newEvidence'],
    ],
  },
  {
    groupCode: 'APPEAL_FORUM',
    displayKey: 'ta.master.appealForum',
    items: [
      ['FIRST_TIER_TRIBUNAL', 'ta.master.appealForum.firstTierTribunal'],
      ['UPPER_TRIBUNAL', 'ta.master.appealForum.upperTribunal'],
      ['COURT_OF_APPEAL', 'ta.master.appealForum.courtOfAppeal'],
    ],
  },
  {
    groupCode: 'CLOSURE_REASON',
    displayKey: 'ta.master.closureReason',
    items: [
      ['SETTLED_IN_FULL', 'ta.master.closureReason.settledInFull'],
      ['NO_RESPONSE_WINDOW_LAPSED', 'ta.master.closureReason.windowLapsed'],
      ['DISPUTE_EXHAUSTED', 'ta.master.closureReason.disputeExhausted'],
      ['TIME_BARRED', 'ta.master.closureReason.timeBarred'],
      ['WRITTEN_OFF', 'ta.master.closureReason.writtenOff'],
    ],
  },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const stamp = { created_at: now, updated_at: now, is_active: true };

    await queryInterface.bulkInsert(
      { schema: 'platform', tableName: 'master_data' },
      CATALOGUES.map((c) => ({
        group_code: c.groupCode,
        jurisdiction_code: JURISDICTION,
        display_key: c.displayKey,
        ...stamp,
      })),
    );

    const [groups] = await queryInterface.sequelize.query(
      `SELECT id, group_code FROM platform.master_data WHERE jurisdiction_code = '${JURISDICTION}'`,
    );
    const groupId = new Map(groups.map((g) => [g.group_code, g.id]));

    const items = [];
    for (const catalogue of CATALOGUES) {
      catalogue.items.forEach(([itemCode, displayKey], index) => {
        items.push({
          master_data_id: groupId.get(catalogue.groupCode),
          item_code: itemCode,
          display_key: displayKey,
          sort_order: (index + 1) * 10,
          ...stamp,
        });
      });
    }
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'master_data_item' }, items);

    // Corporation tax for the demo jurisdiction.
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'tax_type' }, [
      {
        tax_type_code: 'CIT',
        jurisdiction_code: JURISDICTION,
        display_key: 'ta.taxType.CIT',
        applies_to: 'LEGAL',
        default_currency_code: 'GBP',
        ...stamp,
      },
      {
        tax_type_code: 'VAT',
        jurisdiction_code: JURISDICTION,
        display_key: 'ta.taxType.VAT',
        applies_to: 'LEGAL',
        default_currency_code: 'GBP',
        ...stamp,
      },
    ]);

    // A couple of public holidays, so working-day deadline arithmetic has
    // something real to skip over.
    await queryInterface.bulkInsert({ schema: 'platform', tableName: 'holiday' }, [
      {
        jurisdiction_code: JURISDICTION,
        holiday_date: '2026-12-25',
        display_key: 'ta.holiday.christmasDay',
        ...stamp,
      },
      {
        jurisdiction_code: JURISDICTION,
        holiday_date: '2026-12-26',
        display_key: 'ta.holiday.boxingDay',
        ...stamp,
      },
      {
        jurisdiction_code: JURISDICTION,
        holiday_date: '2027-01-01',
        display_key: 'ta.holiday.newYearsDay',
        ...stamp,
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'holiday' }, {});
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'tax_type' }, {});
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'master_data_item' }, {});
    await queryInterface.bulkDelete({ schema: 'platform', tableName: 'master_data' }, {});
  },
};
