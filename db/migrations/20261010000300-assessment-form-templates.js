'use strict';

/**
 * The assessment forms, as configuration.
 *
 * Plan reference: V2 sections 11.2 (template catalogue), 11.4 (shared
 * conventions), 18.2 ("the working area is **always** the DynaForms
 * renderer").
 *
 * ## Why this migration exists
 *
 * The workbench's adjustment form was written as markup. That works, and it
 * breaks the one design rule the plan states most forcefully, for the reason
 * V1 recorded: a hand-written assessment form becomes a component nobody can
 * configure for a new jurisdiction. The Saudi exercise proved the rest of the
 * system configurable; this form would have been the exception.
 *
 * So the form becomes a template. Adding a field for one jurisdiction is now
 * an edit in the form builder, and the renderer, its validation and its
 * dependency engine apply to it like any other form.
 *
 * ## Why the amount field is NUMBER and still safe
 *
 * The renderer draws `NUMBER` as `type="text"` with `inputmode="decimal"`, so
 * the browser never parses a monetary string into a double and no spinner
 * invites an officer to nudge a tax figure (ADR-007). The currency is not set
 * on the element, because it belongs to the case rather than to the form —
 * the workbench shows it beside the field.
 *
 * ## Why the buttons are in the template
 *
 * Plan 18.2: action buttons come from the form's `ButtonGroup`, so the
 * workbench hard-codes no workflow actions. The renderer emits the button's
 * key and the screen decides what to call; what the officer is offered is
 * configuration.
 */

/** Field types, from `@tas/dynaforms-core`. Repeated here because a migration cannot import it. */
const SECTION = 4;
const TEXTAREA = 3;
const DROPDOWN = 6;
const NUMBER = 11;
const BUTTON = 14;
const BUTTONGROUP = 22;

const ADJUSTMENT_FORM = {
  schemaVersion: '1.0',
  root: [
    {
      uuid: 'ta060000-0000-4000-8000-000000000001',
      jsonKey: 'adjustmentSection',
      fieldType: SECTION,
      displayKey: 'ta.form.adjustment.section',
      children: [
        {
          uuid: 'ta060000-0000-4000-8000-000000000002',
          jsonKey: 'adjustmentType',
          fieldType: DROPDOWN,
          displayKey: 'ta.form.adjustment.type',
          required: true,
          options: [
            {
              value: 'UNDERSTATED_REVENUE',
              label: 'Understated revenue',
              displayKey: 'ta.adjustment.understatedRevenue',
            },
            {
              value: 'DISALLOWED_EXPENSE',
              label: 'Disallowed expense',
              displayKey: 'ta.adjustment.disallowedExpense',
            },
            {
              value: 'UNSUPPORTED_DEDUCTION',
              label: 'Unsupported deduction',
              displayKey: 'ta.adjustment.unsupportedDeduction',
            },
            {
              value: 'TRANSFER_PRICING',
              label: 'Transfer pricing',
              displayKey: 'ta.adjustment.transferPricing',
            },
            {
              value: 'TIMING_DIFFERENCE',
              label: 'Timing difference',
              displayKey: 'ta.adjustment.timingDifference',
            },
            { value: 'OTHER', label: 'Other', displayKey: 'ta.adjustment.other' },
          ],
        },
        {
          uuid: 'ta060000-0000-4000-8000-000000000003',
          jsonKey: 'reasonCode',
          fieldType: DROPDOWN,
          displayKey: 'ta.form.adjustment.reason',
          required: true,
          options: [
            {
              value: 'THIRD_PARTY_MISMATCH',
              label: 'Third-party data does not match the return',
              displayKey: 'ta.reason.thirdPartyMismatch',
            },
            {
              value: 'BANK_RECONCILIATION',
              label: 'Bank records do not reconcile',
              displayKey: 'ta.reason.bankReconciliation',
            },
            {
              value: 'NO_EVIDENCE_PROVIDED',
              label: 'No evidence provided when requested',
              displayKey: 'ta.reason.noEvidenceProvided',
            },
            {
              value: 'RATIO_ANALYSIS',
              label: 'Out of line on ratio analysis',
              displayKey: 'ta.reason.ratioAnalysis',
            },
            {
              value: 'PRIOR_YEAR_PATTERN',
              label: 'Inconsistent with prior years',
              displayKey: 'ta.reason.priorYearPattern',
            },
            {
              value: 'TAXPAYER_ADMISSION',
              label: 'Admitted by the taxpayer',
              displayKey: 'ta.reason.taxpayerAdmission',
            },
          ],
        },
        {
          uuid: 'ta060000-0000-4000-8000-000000000004',
          jsonKey: 'amount',
          fieldType: NUMBER,
          displayKey: 'ta.form.adjustment.amount',
          required: true,
        },
        {
          uuid: 'ta060000-0000-4000-8000-000000000005',
          jsonKey: 'direction',
          fieldType: DROPDOWN,
          displayKey: 'ta.form.adjustment.direction',
          required: true,
          options: [
            { value: 'ADD', label: 'Add to the assessed base', displayKey: 'ta.direction.add' },
            {
              value: 'DEDUCT',
              label: 'Deduct from the assessed base',
              displayKey: 'ta.direction.deduct',
            },
          ],
        },
        {
          uuid: 'ta060000-0000-4000-8000-000000000006',
          jsonKey: 'narrative',
          fieldType: TEXTAREA,
          displayKey: 'ta.form.adjustment.narrative',
          /**
           * Not marked required here.
           *
           * Materiality decides whether a narrative is needed, and materiality
           * is a rule-set figure that varies by jurisdiction. The server holds
           * that rule; a `required` flag in the template would be a second
           * opinion about it, in the place least able to see the amount
           * threshold in force.
           */
        },
      ],
    },
    {
      uuid: 'ta060000-0000-4000-8000-000000000007',
      jsonKey: 'actions',
      fieldType: BUTTONGROUP,
      displayKey: 'ta.form.adjustment.actions',
      children: [
        {
          uuid: 'ta060000-0000-4000-8000-000000000008',
          jsonKey: 'record',
          fieldType: BUTTON,
          displayKey: 'ta.form.adjustment.record',
        },
      ],
    },
  ],
};

/** Every key the template names, with its English label. */
const LABELS = {
  'ta.form.adjustment.section': 'Record an adjustment',
  'ta.form.adjustment.type': 'Adjustment type',
  'ta.form.adjustment.reason': 'Reason',
  'ta.form.adjustment.amount': 'Amount',
  'ta.form.adjustment.direction': 'Direction',
  'ta.form.adjustment.narrative': 'Narrative',
  'ta.form.adjustment.actions': 'Actions',
  'ta.form.adjustment.record': 'Record adjustment',

  'ta.adjustment.understatedRevenue': 'Understated revenue',
  'ta.adjustment.disallowedExpense': 'Disallowed expense',
  'ta.adjustment.unsupportedDeduction': 'Unsupported deduction',
  'ta.adjustment.transferPricing': 'Transfer pricing',
  'ta.adjustment.timingDifference': 'Timing difference',
  'ta.adjustment.other': 'Other',

  'ta.reason.thirdPartyMismatch': 'Third-party data does not match the return',
  'ta.reason.bankReconciliation': 'Bank records do not reconcile',
  'ta.reason.noEvidenceProvided': 'No evidence provided when requested',
  'ta.reason.ratioAnalysis': 'Out of line on ratio analysis',
  'ta.reason.priorYearPattern': 'Inconsistent with prior years',
  'ta.reason.taxpayerAdmission': 'Admitted by the taxpayer',

  'ta.direction.add': 'Add to the assessed base',
  'ta.direction.deduct': 'Deduct from the assessed base',
};

module.exports = {
  async up(queryInterface) {
    for (const [key, label] of Object.entries(LABELS)) {
      await queryInterface.sequelize.query(
        `INSERT INTO platform.display_key (key, context, created_at, updated_at, is_active)
         VALUES (:key, 'Assessment adjustment form', now(), now(), true)
         ON CONFLICT (key) DO NOTHING`,
        { replacements: { key } },
      );
      await queryInterface.sequelize.query(
        `INSERT INTO platform.display_key_label
                (display_key_id, language_code, label, created_at, updated_at, is_active)
         SELECT k.id, 'en', :label, now(), now(), true
           FROM platform.display_key k
          WHERE k.key = :key
            AND NOT EXISTS (
              SELECT 1 FROM platform.display_key_label l
               WHERE l.display_key_id = k.id AND l.language_code = 'en')`,
        { replacements: { key, label } },
      );
    }

    // Published straight away. A template nobody published is a template the
    // workbench cannot render, and this one is part of the release rather
    // than something an administrator drafts.
    await queryInterface.sequelize.query(
      `INSERT INTO forms.form_template
              (category_id, template_code, version, display_key, definition, schema_version,
               status, published_at, created_at, updated_at, is_active)
       SELECT c.id, 'TA-06-ADJUSTMENT', 1, 'ta.form.adjustment.section',
              CAST(:definition AS jsonb), '1.0.0', 'PUBLISHED', now(), now(), now(), true
         FROM forms.form_category c
        WHERE c.category_code = 'TAX'
          AND NOT EXISTS (
            SELECT 1 FROM forms.form_template t WHERE t.template_code = 'TA-06-ADJUSTMENT')`,
      { replacements: { definition: JSON.stringify(ADJUSTMENT_FORM) } },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM forms.form_template WHERE template_code = 'TA-06-ADJUSTMENT'`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM platform.display_key_label
        WHERE display_key_id IN (
          SELECT id FROM platform.display_key WHERE key LIKE 'ta.form.adjustment.%'
             OR key LIKE 'ta.adjustment.%' OR key LIKE 'ta.reason.%' OR key LIKE 'ta.direction.%')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM platform.display_key
        WHERE key LIKE 'ta.form.adjustment.%' OR key LIKE 'ta.adjustment.%'
           OR key LIKE 'ta.reason.%' OR key LIKE 'ta.direction.%'`,
    );
  },
};
