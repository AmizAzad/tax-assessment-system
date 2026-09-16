import {
  FieldType,
  applyClearOnHide,
  evaluateCondition,
  resolveFormState,
  validateSubmission,
  type FormDefinition,
  type FormElement,
} from '../src';

/**
 * A cut-down TA-06 Adjustment form.
 *
 * Modelled on the real template design (plan section 11.3) so the tests
 * exercise the shapes the system actually needs rather than invented ones.
 */
const field = (partial: Partial<FormElement> & Pick<FormElement, 'jsonKey' | 'fieldType'>) =>
  ({ uuid: `u-${partial.jsonKey}`, ...partial }) as FormElement;

const ADJUSTMENT_FORM: FormDefinition = {
  schemaVersion: '1.0.0',
  root: [
    field({
      jsonKey: 'adjustmentSection',
      fieldType: FieldType.SECTION,
      children: [
        field({
          jsonKey: 'adjustmentType',
          fieldType: FieldType.DROPDOWN,
          required: true,
          options: [
            { label: 'Statutory disallowance', value: 'STATUTORY_DISALLOWANCE' },
            { label: 'Understated revenue', value: 'UNDERSTATED_REVENUE' },
            { label: 'Timing difference', value: 'TIMING_DIFFERENCE' },
          ],
        }),
        field({
          jsonKey: 'reasonCode',
          fieldType: FieldType.DROPDOWN,
          required: true,
          options: [
            { label: 'No supporting evidence', value: 'NO_SUPPORTING_EVIDENCE' },
            { label: 'Capital in nature', value: 'CAPITAL_IN_NATURE' },
            { label: 'Arithmetic error', value: 'ARITHMETIC_ERROR' },
          ],
          // Reason codes are filtered by adjustment type.
          dependsOn: {
            rules: [
              {
                conditions: [
                  { field: 'adjustmentType', operator: 'eq', value: 'STATUTORY_DISALLOWANCE' },
                ],
                effects: [{ type: 'filterOptions', allowedValues: ['CAPITAL_IN_NATURE'] }],
              },
            ],
          },
        }),
        field({
          jsonKey: 'statutoryReference',
          fieldType: FieldType.TEXTBOX,
          hidden: true,
          // Visible only for a statutory disallowance.
          dependsOn: {
            rules: [
              {
                conditions: [
                  { field: 'adjustmentType', operator: 'eq', value: 'STATUTORY_DISALLOWANCE' },
                ],
                effects: [
                  { type: 'setVisibility', value: true },
                  { type: 'setRequired', value: true },
                ],
              },
            ],
          },
          clearOnHide: true,
        }),
        field({
          jsonKey: 'declaredAmount',
          fieldType: FieldType.NUMBER,
          currency: 'GBP',
          source: 'server',
        }),
        field({
          jsonKey: 'assessedAmount',
          fieldType: FieldType.NUMBER,
          currency: 'GBP',
          required: true,
          min: 0,
          validationRules: [
            {
              uuid: 'v1',
              formula: '@assessedAmount >= 0',
              errorKey: 'ta.error.assessedAmount.negative',
            },
          ],
        }),
        field({
          jsonKey: 'differenceAmount',
          fieldType: FieldType.FORMULA,
          currency: 'GBP',
          formula: '@assessedAmount - @declaredAmount',
          source: 'server',
        }),
        field({
          jsonKey: 'narrative',
          fieldType: FieldType.TEXTAREA,
          minLength: 10,
          // Mandatory once the assessment differs from the declaration.
          dependsOn: {
            rules: [
              {
                conditions: [{ field: 'differenceAmount', operator: 'neq', value: 0 }],
                effects: [{ type: 'setRequired', value: true }],
              },
            ],
          },
        }),
        field({
          jsonKey: 'officerOpinion',
          fieldType: FieldType.TEXTAREA,
          readOnlyForRoles: ['TA_REVIEWER', 'TA_APPROVER_L1'],
        }),
      ],
    }),
  ],
};

describe('dependency engine - conditions', () => {
  const values = {
    text: 'hello world',
    number: 42,
    blank: '',
    nothing: null,
    list: ['A', 'B'],
    flag: true,
  };

  it.each([
    ['eq', 'number', 42, true],
    ['eq', 'number', 41, false],
    ['neq', 'number', 41, true],
    ['lt', 'number', 50, true],
    ['lt', 'number', 10, false],
    ['gt', 'number', 10, true],
    ['lte', 'number', 42, true],
    ['gte', 'number', 42, true],
    ['contains', 'text', 'world', true],
    ['contains', 'text', 'planet', false],
    ['contains', 'list', 'A', true],
    ['contains', 'list', 'Z', false],
  ] as const)('%s on %s', (operator, fieldKey, value, expected) => {
    expect(evaluateCondition({ field: fieldKey, operator, value }, values)).toBe(expected);
  });

  it('treats empty string, null and missing as empty', () => {
    expect(evaluateCondition({ field: 'blank', operator: 'empty' }, values)).toBe(true);
    expect(evaluateCondition({ field: 'nothing', operator: 'empty' }, values)).toBe(true);
    expect(evaluateCondition({ field: 'absent', operator: 'empty' }, values)).toBe(true);
    expect(evaluateCondition({ field: 'text', operator: 'notEmpty' }, values)).toBe(true);
  });

  it('matches across the string/number boundary', () => {
    // A browser posts "42"; an API client posts 42. Both must match.
    expect(evaluateCondition({ field: 'number', operator: 'eq', value: '42' }, values)).toBe(true);
    expect(evaluateCondition({ field: 'flag', operator: 'eq', value: 'true' }, values)).toBe(true);
  });

  it('returns false rather than throwing on an uncomparable value', () => {
    expect(evaluateCondition({ field: 'text', operator: 'gt', value: 5 }, values)).toBe(false);
    expect(evaluateCondition({ field: 'absent', operator: 'lt', value: 5 }, values)).toBe(false);
  });
});

describe('dependency engine - state resolution', () => {
  it('restores the authored baseline when no rule matches', () => {
    const state = resolveFormState(ADJUSTMENT_FORM, { adjustmentType: 'TIMING_DIFFERENCE' });
    expect(state.get('statutoryReference')).toMatchObject({ visible: false, required: false });
    expect(state.get('assessedAmount')).toMatchObject({ required: true });
  });

  it('applies visibility and required together when a rule matches', () => {
    const state = resolveFormState(ADJUSTMENT_FORM, {
      adjustmentType: 'STATUTORY_DISALLOWANCE',
    });
    expect(state.get('statutoryReference')).toMatchObject({ visible: true, required: true });
  });

  it('reverses an effect when the triggering value changes back', () => {
    const on = resolveFormState(ADJUSTMENT_FORM, { adjustmentType: 'STATUTORY_DISALLOWANCE' });
    const off = resolveFormState(ADJUSTMENT_FORM, { adjustmentType: 'TIMING_DIFFERENCE' });
    expect(on.get('statutoryReference')?.visible).toBe(true);
    expect(off.get('statutoryReference')?.visible).toBe(false);
  });

  it('never leaves a hidden field required', () => {
    // Demanding a value the user cannot see produces a form that cannot be
    // submitted and gives no clue why.
    const definition: FormDefinition = {
      schemaVersion: '1.0.0',
      root: [
        field({
          jsonKey: 'x',
          fieldType: FieldType.TEXTBOX,
          required: true,
          dependsOn: {
            rules: [
              {
                conditions: [{ field: 'toggle', operator: 'eq', value: 'no' }],
                effects: [{ type: 'setVisibility', value: false }],
              },
            ],
          },
        }),
      ],
    };
    const state = resolveFormState(definition, { toggle: 'no' });
    expect(state.get('x')).toMatchObject({ visible: false, required: false });
  });

  it('narrows an option list with filterOptions', () => {
    const state = resolveFormState(ADJUSTMENT_FORM, {
      adjustmentType: 'STATUTORY_DISALLOWANCE',
    });
    expect(state.get('reasonCode')?.allowedValues).toEqual(['CAPITAL_IN_NATURE']);
  });

  it('applies setFieldProps', () => {
    const definition: FormDefinition = {
      schemaVersion: '1.0.0',
      root: [
        field({
          jsonKey: 'note',
          fieldType: FieldType.TEXTAREA,
          minLength: 5,
          dependsOn: {
            rules: [
              {
                conditions: [{ field: 'strict', operator: 'eq', value: true }],
                effects: [{ type: 'setFieldProps', props: { minLength: 50 } }],
              },
            ],
          },
        }),
      ],
    };
    expect(resolveFormState(definition, { strict: true }).get('note')?.minLength).toBe(50);
    expect(resolveFormState(definition, { strict: false }).get('note')?.minLength).toBe(5);
  });

  it('combines conditions with AND and OR', () => {
    const rule = (combinator: 'AND' | 'OR') => ({
      schemaVersion: '1.0.0',
      root: [
        field({
          jsonKey: 'x',
          fieldType: FieldType.TEXTBOX,
          hidden: true,
          dependsOn: {
            rules: [
              {
                combinator,
                conditions: [
                  { field: 'a', operator: 'eq' as const, value: 1 },
                  { field: 'b', operator: 'eq' as const, value: 2 },
                ],
                effects: [{ type: 'setVisibility' as const, value: true }],
              },
            ],
          },
        }),
      ],
    });
    expect(resolveFormState(rule('AND'), { a: 1, b: 2 }).get('x')?.visible).toBe(true);
    expect(resolveFormState(rule('AND'), { a: 1, b: 9 }).get('x')?.visible).toBe(false);
    expect(resolveFormState(rule('OR'), { a: 1, b: 9 }).get('x')?.visible).toBe(true);
    expect(resolveFormState(rule('OR'), { a: 8, b: 9 }).get('x')?.visible).toBe(false);
  });
});

describe('dependency engine - clearOnHide', () => {
  it('drops a value for a field that became hidden', () => {
    // Otherwise a field filled in and then hidden keeps its value and is
    // submitted, carrying an adjustment the officer believes they removed.
    const values = {
      adjustmentType: 'TIMING_DIFFERENCE',
      statutoryReference: 's.54 CTA 2009',
    };
    const state = resolveFormState(ADJUSTMENT_FORM, values);
    expect(applyClearOnHide(ADJUSTMENT_FORM, values, state)).not.toHaveProperty(
      'statutoryReference',
    );
  });

  it('keeps the value while the field is visible', () => {
    const values = {
      adjustmentType: 'STATUTORY_DISALLOWANCE',
      statutoryReference: 's.54 CTA 2009',
    };
    const state = resolveFormState(ADJUSTMENT_FORM, values);
    expect(applyClearOnHide(ADJUSTMENT_FORM, values, state)).toHaveProperty(
      'statutoryReference',
      's.54 CTA 2009',
    );
  });
});

describe('validation engine', () => {
  const base = {
    adjustmentType: 'TIMING_DIFFERENCE',
    reasonCode: 'ARITHMETIC_ERROR',
    declaredAmount: 100000,
    assessedAmount: 100000,
    differenceAmount: 0,
    narrative: '',
    officerOpinion: '',
  };

  it('accepts a well-formed submission', () => {
    expect(validateSubmission(ADJUSTMENT_FORM, base, { previousValues: base }).valid).toBe(true);
  });

  it('reports a missing required field', () => {
    const result = validateSubmission(
      ADJUSTMENT_FORM,
      { ...base, assessedAmount: null },
      { previousValues: base },
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'assessedAmount', rule: 'required' }),
    );
  });

  it('requires a field made mandatory by a dependency', () => {
    // narrative becomes required once difference != 0
    const values = { ...base, assessedAmount: 125000, differenceAmount: 25000, narrative: '' };
    const result = validateSubmission(ADJUSTMENT_FORM, values, { previousValues: values });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'narrative', rule: 'required' }),
    );
  });

  it('does not validate a field hidden by a dependency', () => {
    // statutoryReference is required when visible, but hidden here.
    const result = validateSubmission(ADJUSTMENT_FORM, base, { previousValues: base });
    expect(result.errors.map((e) => e.jsonKey)).not.toContain('statutoryReference');
  });

  it('enforces minLength', () => {
    const values = { ...base, assessedAmount: 125000, differenceAmount: 25000, narrative: 'short' };
    const result = validateSubmission(ADJUSTMENT_FORM, values, { previousValues: values });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'narrative', rule: 'minLength' }),
    );
  });

  it('enforces a numeric minimum', () => {
    const values = { ...base, assessedAmount: -5 };
    const result = validateSubmission(ADJUSTMENT_FORM, values, { previousValues: base });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'assessedAmount', rule: 'min' }),
    );
  });

  it('evaluates a formula validation rule', () => {
    const values = { ...base, assessedAmount: -5 };
    const result = validateSubmission(ADJUSTMENT_FORM, values, { previousValues: base });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ errorKey: 'ta.error.assessedAmount.negative', rule: 'formula' }),
    );
  });

  it('rejects a value outside the option list', () => {
    const values = { ...base, adjustmentType: 'SOMETHING_INVENTED' };
    const result = validateSubmission(ADJUSTMENT_FORM, values, { previousValues: base });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'adjustmentType', rule: 'notAnOption' }),
    );
  });

  it('rejects an option excluded by filterOptions', () => {
    // ARITHMETIC_ERROR is a valid option in the definition but is filtered out
    // for a statutory disallowance. The server must enforce the filter.
    const values = {
      ...base,
      adjustmentType: 'STATUTORY_DISALLOWANCE',
      statutoryReference: 's.54',
      reasonCode: 'ARITHMETIC_ERROR',
    };
    const result = validateSubmission(ADJUSTMENT_FORM, values, { previousValues: base });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'reasonCode', rule: 'notAnOption' }),
    );
  });

  it('anchors a regex so a partial match does not pass', () => {
    const definition: FormDefinition = {
      schemaVersion: '1.0.0',
      root: [
        field({
          jsonKey: 'tin',
          fieldType: FieldType.TEXTBOX,
          regexConfig: { pattern: '[0-9]{10}', errorKey: 'ta.error.tin.format' },
        }),
      ],
    };
    const ok = validateSubmission(definition, { tin: '1234567890' }, { previousValues: {} });
    expect(ok.valid).toBe(true);

    // Would pass an unanchored test; must not pass a format check.
    const bad = validateSubmission(definition, { tin: 'XX1234567890YY' }, { previousValues: {} });
    expect(bad.errors).toContainEqual(expect.objectContaining({ rule: 'pattern' }));
  });
});

/**
 * The trust-boundary checks.
 *
 * These are the reason validation runs on the server at all. A browser can be
 * bypassed entirely; these rules hold regardless.
 */
describe('validation engine - trust boundary', () => {
  const stored = {
    adjustmentType: 'TIMING_DIFFERENCE',
    reasonCode: 'ARITHMETIC_ERROR',
    declaredAmount: 100000,
    assessedAmount: 100000,
    differenceAmount: 0,
    narrative: '',
    officerOpinion: 'Original opinion',
  };

  it('rejects a client-modified server-owned field', () => {
    // declaredAmount comes from the evidence snapshot. A caller must not be
    // able to restate what the taxpayer declared (ADR-006).
    const tampered = { ...stored, declaredAmount: 1 };
    const result = validateSubmission(ADJUSTMENT_FORM, tampered, { previousValues: stored });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'declaredAmount', rule: 'serverOwned' }),
    );
  });

  it('rejects a client-computed calculation result', () => {
    const tampered = { ...stored, differenceAmount: -999999 };
    const result = validateSubmission(ADJUSTMENT_FORM, tampered, { previousValues: stored });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'differenceAmount', rule: 'serverOwned' }),
    );
  });

  it('accepts a server-owned field that is unchanged', () => {
    const result = validateSubmission(ADJUSTMENT_FORM, stored, { previousValues: stored });
    expect(result.errors.map((e) => e.rule)).not.toContain('serverOwned');
  });

  it('rejects a change to a field the caller may not edit', () => {
    const tampered = { ...stored, officerOpinion: 'Edited by the reviewer' };
    const result = validateSubmission(ADJUSTMENT_FORM, tampered, {
      previousValues: stored,
      roleCodes: ['TA_REVIEWER'],
    });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'officerOpinion', rule: 'readOnly' }),
    );
  });

  it('allows the same change from a role that may edit it', () => {
    const edited = { ...stored, officerOpinion: 'Edited by the assessor' };
    const result = validateSubmission(ADJUSTMENT_FORM, edited, {
      previousValues: stored,
      roleCodes: ['TA_ASSESSOR'],
    });
    expect(result.errors.map((e) => e.rule)).not.toContain('readOnly');
  });

  it('treats a first submission of a server-owned field as a change', () => {
    // With no stored baseline, a caller must not be able to smuggle in a
    // server-owned figure on create.
    const result = validateSubmission(ADJUSTMENT_FORM, { ...stored, declaredAmount: 50 }, {});
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'declaredAmount', rule: 'serverOwned' }),
    );
  });
});
