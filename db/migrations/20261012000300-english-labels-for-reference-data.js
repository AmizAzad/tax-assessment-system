'use strict';

/**
 * English labels for the reference data and the demo return.
 *
 * Plan reference: V2 section 16 (i18n by display key).
 *
 * ## The defect
 *
 * Master-data items, their groups and the CIT return template all carry a
 * display key, and none of those keys had a label. Every screen that lists
 * them — Reference Data, the objection grounds, appeal forums and closure
 * reasons on the case, the forms register — showed `ta.master.closureReason
 * .settledInFull` or fell back to the raw code. The keys were written by the
 * migrations and seeds that created the items; the labels never were.
 *
 * ## Why a migration and not the seed
 *
 * The items themselves are created by migrations for both jurisdictions, so
 * a label belongs next to them on every environment, not only where the demo
 * data is loaded. `cit.*` is the one exception, belonging to the seeded demo
 * return; labelling a key nothing uses costs a row and nothing else.
 *
 * Existing labels are left alone, so a label an administrator has already
 * edited is not overwritten.
 */
const LABELS = {
  'ta.master.adjustmentType': 'Adjustment types',
  'ta.master.adjustmentType.statutoryDisallowance': 'Statutory disallowance',
  'ta.master.adjustmentType.understatedRevenue': 'Understated revenue',
  'ta.master.adjustmentType.overstatedExpense': 'Overstated expense',
  'ta.master.adjustmentType.timingDifference': 'Timing difference',
  'ta.master.adjustmentType.transferPricing': 'Transfer pricing',

  'ta.master.adjustmentReason': 'Adjustment reasons',
  'ta.master.adjustmentReason.arithmeticError': 'Arithmetic error in the return',
  'ta.master.adjustmentReason.capitalInNature': 'Capital in nature',
  'ta.master.adjustmentReason.noSupportingEvidence': 'No supporting evidence',
  'ta.master.adjustmentReason.notWhollyExclusively': 'Not wholly and exclusively for the trade',
  'ta.master.adjustmentReason.thirdPartyMismatch': 'Third-party data does not match the return',

  'ta.master.objectionGround': 'Objection grounds',
  'ta.master.objectionGround.factualError': 'Factual error',
  'ta.master.objectionGround.legalInterpretation': 'Interpretation of the law',
  'ta.master.objectionGround.newEvidence': 'New evidence',
  'ta.master.objectionGround.proceduralIrregularity': 'Procedural irregularity',

  'ta.master.appealForum': 'Appeal forums',
  'ta.master.appealForum.firstTierTribunal': 'First-tier Tribunal',
  'ta.master.appealForum.upperTribunal': 'Upper Tribunal',
  'ta.master.appealForum.courtOfAppeal': 'Court of Appeal',

  'ta.master.closureReason': 'Closure reasons',
  'ta.master.closureReason.settledInFull': 'Settled in full',
  'ta.master.closureReason.disputeExhausted': 'Dispute exhausted',
  'ta.master.closureReason.timeBarred': 'Time-barred',
  'ta.master.closureReason.windowLapsed': 'Objection window lapsed',
  'ta.master.closureReason.writtenOff': 'Written off',

  'ta.masters.adjustment_reason': 'Adjustment reasons',
  'ta.masters.appeal_forum': 'Appeal forums',
  'ta.masters.closure_reason': 'Closure reasons',
  'ta.masters.objection_ground': 'Objection grounds',
  'ta.masters.retentionClass': 'Retention classes',
  'ta.masters.retention_class': 'Retention classes',
  'ta.masters.weekendDays': 'Weekend days',

  'ta.item.undeclared_revenue': 'Undeclared revenue',
  'ta.item.unsupported_expense': 'Unsupported expense',
  'ta.item.related_party_pricing': 'Related-party pricing',
  'ta.item.calculation_error': 'Calculation error',
  'ta.item.assessment_basis_disputed': 'Basis of assessment disputed',
  'ta.item.documents_not_considered': 'Documents not considered',
  'ta.item.penalty_excessive': 'Penalty excessive',
  'ta.item.appellate_committee': 'Appellate committee',
  'ta.item.general_secretariat': 'General Secretariat of Tax Committees',
  'ta.item.supreme_administrative_court': 'Supreme Administrative Court',
  'ta.item.settled_in_full': 'Settled in full',
  'ta.item.dispute_exhausted': 'Dispute exhausted',
  'ta.item.time_barred': 'Time-barred',
  'ta.item.written_off': 'Written off',
  'ta.item.statutory': 'Statutory',
  'ta.item.extended': 'Extended',
  'ta.item.permanent': 'Permanent',

  'ta.retention.statutory': 'Statutory',
  'ta.retention.extended': 'Extended',
  'ta.retention.permanent': 'Permanent',

  'ta.day.fri': 'Friday',
  'ta.day.sat': 'Saturday',
  'ta.day.sun': 'Sunday',

  'cit.return.title': 'Corporation tax return',
  'cit.section.trading': 'Trading',
  'cit.section.otherIncome': 'Other income',
  'cit.field.turnover': 'Turnover',
  'cit.field.tradingProfit': 'Trading profit',
  'cit.field.interestReceived': 'Interest received',
  'cit.field.propertyIncome': 'Property income',
};

module.exports = {
  async up(queryInterface) {
    for (const [key, label] of Object.entries(LABELS)) {
      await queryInterface.sequelize.query(
        `INSERT INTO platform.display_key (key, context, created_at, updated_at, is_active)
         VALUES (:key, 'Reference data and demo return', now(), now(), true)
         ON CONFLICT (key) DO NOTHING`,
        { replacements: { key } },
      );
      await queryInterface.sequelize.query(
        `INSERT INTO platform.display_key_label
                (display_key_id, language_code, label, created_at, updated_at, is_active)
         SELECT k.id, 'en', :label, now(), now(), true
           FROM platform.display_key k
          WHERE k.key = :key
         ON CONFLICT (display_key_id, language_code) DO NOTHING`,
        { replacements: { key, label } },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM platform.display_key_label
        WHERE language_code = 'en'
          AND display_key_id IN (SELECT id FROM platform.display_key WHERE key IN (:keys))`,
      { replacements: { keys: Object.keys(LABELS) } },
    );
  },
};
