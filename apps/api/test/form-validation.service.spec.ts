import { FieldType, type FormDefinition } from '@tas/dynaforms-core';
import { FormValidationService } from '../src/forms/form-validation.service';

/**
 * The forked form core, running inside the API.
 *
 * This is the other half of the ADR-005 spike: the package tests prove the
 * core is framework-free, and this proves the API actually consumes it. If
 * these pass, server-side validation is the same code the browser runs rather
 * than a re-implementation.
 */

const DEFINITION: FormDefinition = {
  schemaVersion: '1.0.0',
  root: [
    {
      uuid: 'u-root',
      jsonKey: 'root',
      fieldType: FieldType.SECTION,
      children: [
        {
          uuid: 'u-type',
          jsonKey: 'adjustmentType',
          fieldType: FieldType.DROPDOWN,
          required: true,
          options: [
            { label: 'Statutory disallowance', value: 'STATUTORY_DISALLOWANCE' },
            { label: 'Timing difference', value: 'TIMING_DIFFERENCE' },
          ],
        },
        {
          uuid: 'u-ref',
          jsonKey: 'statutoryReference',
          fieldType: FieldType.TEXTBOX,
          hidden: true,
          clearOnHide: true,
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
        },
        {
          uuid: 'u-declared',
          jsonKey: 'declaredAmount',
          fieldType: FieldType.NUMBER,
          source: 'server',
        },
        {
          uuid: 'u-opinion',
          jsonKey: 'officerOpinion',
          fieldType: FieldType.TEXTAREA,
          readOnlyForRoles: ['TA_REVIEWER'],
        },
      ],
    },
  ],
};

describe('FormValidationService', () => {
  const service = new FormValidationService();

  it('accepts a valid submission', () => {
    const stored = { adjustmentType: 'TIMING_DIFFERENCE', declaredAmount: 100, officerOpinion: '' };
    const { result } = service.accept(DEFINITION, stored, {
      roleCodes: ['TA_ASSESSOR'],
      previousValues: stored,
    });
    expect(result.valid).toBe(true);
  });

  it('enforces a dependency-driven requirement server-side', () => {
    const { result } = service.accept(
      DEFINITION,
      { adjustmentType: 'STATUTORY_DISALLOWANCE', declaredAmount: 100 },
      { roleCodes: ['TA_ASSESSOR'], previousValues: { declaredAmount: 100 } },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'statutoryReference', rule: 'required' }),
    );
  });

  it('strips a hidden clearOnHide value from what gets stored', () => {
    // The caller sent a statutory reference alongside a timing difference.
    // It must not be persisted: the field is not visible for that type.
    const { values } = service.accept(
      DEFINITION,
      {
        adjustmentType: 'TIMING_DIFFERENCE',
        statutoryReference: 's.54 CTA 2009',
        declaredAmount: 100,
      },
      { roleCodes: ['TA_ASSESSOR'], previousValues: { declaredAmount: 100 } },
    );
    expect(values).not.toHaveProperty('statutoryReference');
  });

  it('rejects a client-modified server-owned field', () => {
    const stored = { adjustmentType: 'TIMING_DIFFERENCE', declaredAmount: 100 };
    const { result } = service.accept(
      DEFINITION,
      { ...stored, declaredAmount: 1 },
      { roleCodes: ['TA_ASSESSOR'], previousValues: stored },
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'declaredAmount', rule: 'serverOwned' }),
    );
  });

  it('enforces field-level role access on submit, not just in the renderer', () => {
    const stored = {
      adjustmentType: 'TIMING_DIFFERENCE',
      declaredAmount: 100,
      officerOpinion: 'Original',
    };
    const { result } = service.accept(
      DEFINITION,
      { ...stored, officerOpinion: 'Edited by a reviewer' },
      { roleCodes: ['TA_REVIEWER'], previousValues: stored },
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'officerOpinion', rule: 'readOnly' }),
    );
  });

  it('rejects an option value the browser should never have offered', () => {
    const { result } = service.accept(
      DEFINITION,
      { adjustmentType: 'INVENTED', declaredAmount: 100 },
      { roleCodes: ['TA_ASSESSOR'], previousValues: { declaredAmount: 100 } },
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ jsonKey: 'adjustmentType', rule: 'notAnOption' }),
    );
  });
});

describe('FormValidationService.validateDefinition', () => {
  it('passes a well-formed definition', () => {
    expect(new FormValidationService().validateDefinition(DEFINITION)).toEqual({
      valid: true,
      problems: [],
    });
  });

  it('rejects a circular formula reference before publication', () => {
    // Otherwise this is an infinite loop the first time an officer opens the
    // form.
    const circular: FormDefinition = {
      schemaVersion: '1.0.0',
      root: [
        { uuid: 'a', jsonKey: 'a', fieldType: FieldType.FORMULA, formula: '@b + 1' },
        { uuid: 'b', jsonKey: 'b', fieldType: FieldType.FORMULA, formula: '@a + 1' },
      ],
    };
    const outcome = new FormValidationService().validateDefinition(circular);
    expect(outcome.valid).toBe(false);
    expect(outcome.problems[0]).toMatch(/Circular formula reference/);
  });

  it('reports an unparseable formula rather than throwing', () => {
    const broken: FormDefinition = {
      schemaVersion: '1.0.0',
      root: [{ uuid: 'a', jsonKey: 'a', fieldType: FieldType.FORMULA, formula: 'ROUND(@b, 2)' }],
    };
    const outcome = new FormValidationService().validateDefinition(broken);
    expect(outcome.valid).toBe(false);
    expect(outcome.problems[0]).toMatch(/no functions/i);
  });
});
