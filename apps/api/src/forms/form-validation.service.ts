import { Injectable, Logger } from '@nestjs/common';
import {
  applyClearOnHide,
  findCircularReferences,
  resolveFormState,
  validateSubmission,
  type FormDefinition,
  type FormValues,
  type ValidationResult,
} from '@tas/dynaforms-core';

export interface SubmissionContext {
  /** The caller's role codes, for `readOnlyForRoles` enforcement. */
  readonly roleCodes: readonly string[];
  /** The stored values this submission replaces, if any. */
  readonly previousValues?: FormValues;
}

export interface AcceptedSubmission {
  readonly values: FormValues;
  readonly result: ValidationResult;
}

/**
 * Server-side form validation.
 *
 * Plan reference: V2 sections 3.2, 4.5; ADR-005, ADR-006.
 *
 * This is the whole point of extracting `dynaforms-core` as a framework-free
 * package: the API runs *exactly* the validation and dependency logic the
 * browser ran, rather than a re-implementation that drifts. Client-side
 * validation is an affordance; this is the control.
 *
 * Nothing tax-specific lives here. The service knows about form definitions
 * and submissions; it has never heard of an assessment.
 */
@Injectable()
export class FormValidationService {
  private readonly logger = new Logger(FormValidationService.name);

  /**
   * Validate a submission and return the values that should actually be stored.
   *
   * The returned values are not the ones that came in: fields hidden by a
   * dependency and marked `clearOnHide` are stripped, so a value the user
   * believes they removed is not quietly persisted.
   */
  accept(
    definition: FormDefinition,
    incoming: FormValues,
    context: SubmissionContext,
  ): AcceptedSubmission {
    const state = resolveFormState(definition, incoming);
    const values = applyClearOnHide(definition, incoming, state);

    const result = validateSubmission(definition, values, {
      roleCodes: context.roleCodes,
      previousValues: context.previousValues,
      state,
    });

    if (!result.valid) {
      // Logged at debug: a failed validation is an expected outcome, not an
      // incident. The field keys are safe to log; the values are not.
      this.logger.debug(
        `Submission rejected: ${result.errors.map((e) => `${e.jsonKey}/${e.rule}`).join(', ')}`,
      );
    }

    return { values, result };
  }

  /**
   * Check a definition before it is published.
   *
   * A circular formula reference is an infinite loop at render time. Catching
   * it at publish means a broken template never reaches an officer.
   */
  validateDefinition(definition: FormDefinition): { valid: boolean; problems: string[] } {
    const problems: string[] = [];

    const formulas: Record<string, string> = {};
    const collect = (elements: FormDefinition['root']): void => {
      for (const element of elements) {
        if (element.formula !== undefined && element.jsonKey !== '') {
          formulas[element.jsonKey] = element.formula;
        }
        if (element.children !== undefined) collect(element.children);
      }
    };
    collect(definition.root);

    try {
      const cycle = findCircularReferences(formulas);
      if (cycle.length > 0) {
        problems.push(`Circular formula reference between: ${cycle.join(', ')}`);
      }
    } catch (error) {
      problems.push(
        `A formula failed to parse: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return { valid: problems.length === 0, problems };
  }
}
