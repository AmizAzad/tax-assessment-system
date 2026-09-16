import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { FormValues, ValidationResult } from '@tas/dynaforms-core';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../infrastructure/tokens';
import type { RequestContext } from '../platform/auth/request-context';
import { currentUserId } from '../platform/auth/request-context';
import { FormTemplateService } from './form-template.service';
import { FormValidationService } from './form-validation.service';

export type SubmissionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface SubmissionRecord {
  readonly id: number;
  readonly uuid: string;
  readonly formTemplateId: number;
  readonly status: SubmissionStatus;
  readonly values: FormValues;
  readonly previousSubmissionUuid?: string;
  readonly contextType?: string;
  readonly contextId?: number;
}

export interface SaveResult {
  readonly submission?: SubmissionRecord;
  readonly validation: ValidationResult;
}

/**
 * Form submission persistence.
 *
 * Plan reference: V2 sections 4.2, 11.4; ADR-005, ADR-006.
 *
 * ## Drafts are not validated, submissions are
 *
 * A half-filled form must be savable — an officer preparing an assessment
 * works across days. Validation is the gate on `submit`, not on `save`.
 *
 * ## The server decides what gets stored
 *
 * `accept()` returns the values to persist, which are not the values that came
 * in: fields hidden by a dependency and marked `clearOnHide` are stripped, so
 * a value the officer believes they removed is not quietly kept. Server-owned
 * and role-read-only fields are rejected if changed (ADR-006).
 *
 * ## Revision, not overwrite
 *
 * A submitted form is superseded by a new row pointing at it through
 * `previous_submission_uuid`, never edited in place. That chain is what makes
 * a revised assessment traceable to the one it replaced.
 */
@Injectable()
export class FormSubmissionService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly templates: FormTemplateService,
    private readonly validation: FormValidationService,
  ) {}

  /** Save without validating. Drafts only. */
  async saveDraft(input: {
    formTemplateId: number;
    values: FormValues;
    contextType?: string;
    contextId?: number;
    existingUuid?: string;
  }): Promise<SubmissionRecord> {
    if (input.existingUuid !== undefined) {
      const existing = await this.findByUuid(input.existingUuid);
      if (existing.status !== 'DRAFT') {
        throw new ConflictException(
          'This submission has been submitted and cannot be edited. Create a revision instead.',
        );
      }
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `UPDATE forms.form_template_data
            SET json = CAST(:values AS jsonb),
                updated_at = CURRENT_TIMESTAMP,
                updated_by = :userId
          WHERE uuid = :uuid
          RETURNING id, uuid, form_template_id, status, json,
                    previous_submission_uuid, context_type, context_id`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            uuid: input.existingUuid,
            values: JSON.stringify(input.values),
            userId: currentUserId() ?? null,
          },
        },
      );
      return toSubmission(rows[0]!);
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO forms.form_template_data
              (form_template_id, json, status, context_type, context_id, created_by)
       VALUES (:formTemplateId, CAST(:values AS jsonb), 'DRAFT', :contextType, :contextId, :userId)
       RETURNING id, uuid, form_template_id, status, json,
                 previous_submission_uuid, context_type, context_id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          formTemplateId: input.formTemplateId,
          values: JSON.stringify(input.values),
          contextType: input.contextType ?? null,
          contextId: input.contextId ?? null,
          userId: currentUserId() ?? null,
        },
      },
    );
    return toSubmission(rows[0]!);
  }

  /**
   * Validate and submit.
   *
   * Returns the validation result either way rather than throwing on invalid
   * input: the caller renders field-level errors, and an invalid form is an
   * expected outcome rather than an exceptional one.
   */
  async submit(input: {
    formTemplateId: number;
    values: FormValues;
    caller: RequestContext;
    contextType?: string;
    contextId?: number;
    existingUuid?: string;
  }): Promise<SaveResult> {
    const template = await this.templates.findById(input.formTemplateId);

    if (template.status !== 'PUBLISHED') {
      throw new BadRequestException(
        `Template ${template.templateCode} v${template.version} is ${template.status}; ` +
          `only a published template accepts submissions`,
      );
    }

    const previousValues =
      input.existingUuid === undefined
        ? undefined
        : (await this.findByUuid(input.existingUuid)).values;

    const accepted = this.validation.accept(template.definition, input.values, {
      roleCodes: input.caller.roleCodes,
      previousValues,
    });

    if (!accepted.result.valid) {
      return { validation: accepted.result };
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO forms.form_template_data
              (form_template_id, json, status, previous_submission_uuid,
               context_type, context_id, submitted_by, submitted_at, created_by)
       VALUES (:formTemplateId, CAST(:values AS jsonb), 'SUBMITTED', :previousUuid,
               :contextType, :contextId, :userId, CURRENT_TIMESTAMP, :userId)
       RETURNING id, uuid, form_template_id, status, json,
                 previous_submission_uuid, context_type, context_id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          formTemplateId: input.formTemplateId,
          // The accepted values, not the incoming ones.
          values: JSON.stringify(accepted.values),
          previousUuid: input.existingUuid ?? null,
          contextType: input.contextType ?? null,
          contextId: input.contextId ?? null,
          userId: currentUserId() ?? null,
        },
      },
    );

    return { submission: toSubmission(rows[0]!), validation: accepted.result };
  }

  async findByUuid(uuid: string): Promise<SubmissionRecord> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, uuid, form_template_id, status, json,
              previous_submission_uuid, context_type, context_id
         FROM forms.form_template_data WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new BadRequestException('No such submission');
    }
    return toSubmission(row);
  }

  /** Submissions for a case, newest first. */
  async listFor(contextType: string, contextId: number): Promise<readonly SubmissionRecord[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, uuid, form_template_id, status, json,
              previous_submission_uuid, context_type, context_id
         FROM forms.form_template_data
        WHERE context_type = :contextType AND context_id = :contextId AND is_active
        ORDER BY created_at DESC`,
      { type: QueryTypes.SELECT, replacements: { contextType, contextId } },
    );
    return rows.map(toSubmission);
  }

  /**
   * The supersession chain for a submission, newest first.
   *
   * How a revised assessment is traced back to the one it replaced.
   */
  async revisionChain(uuid: string): Promise<readonly SubmissionRecord[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `WITH RECURSIVE chain AS (
         SELECT id, uuid, form_template_id, status, json,
                previous_submission_uuid, context_type, context_id, 0 AS depth
           FROM forms.form_template_data WHERE uuid = :uuid
          UNION ALL
         SELECT p.id, p.uuid, p.form_template_id, p.status, p.json,
                p.previous_submission_uuid, p.context_type, p.context_id, c.depth + 1
           FROM forms.form_template_data p
           JOIN chain c ON p.uuid = c.previous_submission_uuid
       )
       SELECT id, uuid, form_template_id, status, json,
              previous_submission_uuid, context_type, context_id
         FROM chain ORDER BY depth`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    return rows.map(toSubmission);
  }
}

function toSubmission(row: Record<string, unknown>): SubmissionRecord {
  return {
    id: Number(row['id']),
    uuid: String(row['uuid']),
    formTemplateId: Number(row['form_template_id']),
    status: String(row['status']) as SubmissionStatus,
    values: row['json'] as FormValues,
    previousSubmissionUuid:
      row['previous_submission_uuid'] === null
        ? undefined
        : String(row['previous_submission_uuid']),
    contextType: row['context_type'] === null ? undefined : String(row['context_type']),
    contextId: row['context_id'] === null ? undefined : Number(row['context_id']),
  };
}
