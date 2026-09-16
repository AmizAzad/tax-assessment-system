import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '@tas/decimal';
import type { FormDefinition, FormElement } from '@tas/dynaforms-core';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import {
  EvidenceUnavailableError,
  type EvidenceItem,
  type EvidencePayload,
  type EvidenceProvider,
  type EvidenceRequest,
} from './evidence-provider';

interface SubmissionRow {
  readonly id: string;
  readonly json: Record<string, unknown> | null;
  readonly definition: FormDefinition | null;
  readonly template_code: string;
  readonly reference_number: string | null;
  readonly submitted_at: Date | null;
}

/**
 * The taxpayer's own filed return.
 *
 * Plan reference: V2 sections 8.2, 8.4.
 *
 * ## Where the figures come from
 *
 * A return is a DynaForms submission in `forms.form_template_data`. Its
 * template carries, on each numeric element, an optional `taxConcept`. This
 * provider walks the template, finds the elements that declare a concept, and
 * reads the matching `jsonKey` out of the submission.
 *
 * The mapping lives on the template rather than in this file because a new
 * form version can move a figure to a different field, and a code change per
 * form version is exactly what a configuration-driven platform exists to
 * avoid.
 *
 * ## Reading the amounts
 *
 * Values are read as strings. A submission holding `12345.67` as a JSON number
 * has already lost exactness before this code runs, so that case is accepted
 * loudly rather than silently, and anything that is not an amount at all is
 * rejected rather than coerced. See ADR-007.
 *
 * ## Why mandatory
 *
 * Assessing a taxpayer without knowing what they declared is a guess, not an
 * assessment. If the filing store cannot be read, the case must not become
 * data-ready. A taxpayer who genuinely did not file is a different situation:
 * the query succeeds and returns no rows, which this provider reports as an
 * empty item list with no filing date, and the penalty step then has what it
 * needs.
 */
@Injectable()
export class FilingEvidenceProvider implements EvidenceProvider {
  readonly code = 'FILING_STORE';
  readonly descriptionKey = 'evidence.source.filingStore';
  readonly mandatory = true;

  private readonly logger = new Logger(FilingEvidenceProvider.name);

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  supports(): boolean {
    return true;
  }

  async fetch(request: EvidenceRequest): Promise<EvidencePayload> {
    const submission = await this.findReturn(request);

    if (submission === undefined) {
      // Not an error. A non-filer is a legitimate and common assessment case,
      // and the absence of a filing date is what drives the late-filing
      // penalty step.
      this.logger.log(
        `No submitted return for TIN ${request.tin} ${request.taxTypeCode} ${request.assessmentYear}`,
      );
      return { items: [], raw: { filed: false } };
    }

    const definition = submission.definition;
    if (definition === null) {
      throw new EvidenceUnavailableError(
        this.code,
        `Return ${submission.reference_number ?? submission.id} has no template definition, ` +
          'so its figures cannot be mapped to tax concepts.',
        false,
      );
    }

    const items = this.mapConcepts(definition, submission.json ?? {}, request.currencyCode);

    return {
      items,
      filedOn: submission.submitted_at?.toISOString().slice(0, 10),
      raw: {
        filed: true,
        submissionId: submission.id,
        templateCode: submission.template_code,
        referenceNumber: submission.reference_number,
      },
    };
  }

  /**
   * The most recent submitted return for this taxpayer, tax type and year.
   *
   * Joined to the template so the concept mapping and the values are read in
   * one consistent shot. Two separate queries could straddle a republish and
   * map this year's values with next year's field meanings.
   */
  private async findReturn(request: EvidenceRequest): Promise<SubmissionRow | undefined> {
    const rows = await this.sequelize.query<SubmissionRow>(
      `SELECT d.id::text AS id,
              d.json,
              t.definition,
              t.template_code,
              d.reference_number,
              d.submitted_at
         FROM forms.form_template_data d
         JOIN forms.form_template t ON t.id = d.form_template_id
        WHERE d.context_type = 'TAXPAYER'
          AND d.context_id = :taxpayerId
          AND d.status = 'SUBMITTED'
          AND d.is_active
          AND t.applies_to_year = :year
          AND t.template_code LIKE :taxTypePrefix
        ORDER BY d.submitted_at DESC NULLS LAST, d.id DESC
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          taxpayerId: request.taxpayerId,
          year: request.assessmentYear,
          taxTypePrefix: `${request.taxTypeCode}-%`,
        },
      },
    );
    return rows[0];
  }

  /**
   * Walk the template collecting every element that declares a tax concept.
   *
   * Groups and sections nest through `children`, so this recurses. An element that declares a
   * concept but whose value is missing from the submission is skipped rather
   * than read as zero: an unanswered question and a declared nil are different
   * claims, and only the second should reduce an assessment.
   */
  private mapConcepts(
    definition: FormDefinition,
    values: Record<string, unknown>,
    currencyCode: string,
  ): readonly EvidenceItem[] {
    const items: EvidenceItem[] = [];
    const seen = new Set<string>();

    const visit = (elements: readonly FormElement[]): void => {
      for (const element of elements) {
        const concept = element.taxConcept;
        if (concept !== undefined && concept !== '') {
          if (seen.has(concept)) {
            // Two fields claiming the same concept would silently double a
            // figure. Refuse rather than pick one.
            throw new EvidenceUnavailableError(
              this.code,
              `Template declares tax concept ${concept} on more than one field, ` +
                'so the return cannot be mapped without ambiguity.',
              false,
            );
          }

          const amount = this.readAmount(values[element.jsonKey], element.jsonKey, currencyCode);
          if (amount !== undefined) {
            seen.add(concept);
            items.push({
              conceptCode: concept,
              labelKey: element.displayKey,
              declaredAmount: amount,
              source: 'FILED',
            });
          }
        }

        if (element.children !== undefined) visit(element.children);
      }
    };

    visit(definition.root);

    return items;
  }

  private readAmount(raw: unknown, jsonKey: string, currencyCode: string): Money | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;

    if (typeof raw === 'string') {
      return Money.of(raw, currencyCode);
    }

    if (typeof raw === 'number') {
      // A JSON number reached the filing store, which means exactness was
      // already lost upstream of this point. Accept it so a real return is not
      // blocked, but say so: the fix is for the submission path to store
      // strings.
      this.logger.warn(
        `Field ${jsonKey} holds a JSON number. Exactness cannot be guaranteed upstream ` +
          'of this point; the submission path should store amounts as strings (ADR-007).',
      );
      return Money.unsafeFromNumber(raw, currencyCode);
    }

    throw new EvidenceUnavailableError(
      this.code,
      `Field ${jsonKey} holds ${typeof raw}, which is not an amount.`,
      false,
    );
  }
}
