import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FormDefinition } from '@tas/dynaforms-core';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../infrastructure/tokens';
import { currentUserId } from '../platform/auth/request-context';
import { FormValidationService } from './form-validation.service';

export type TemplateStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface FormTemplateRecord {
  readonly id: number;
  readonly uuid: string;
  readonly templateCode: string;
  readonly version: number;
  readonly displayKey: string;
  readonly status: TemplateStatus;
  readonly schemaVersion: string;
  readonly appliesToYear?: string;
  readonly definition: FormDefinition;
}

/**
 * Form template lifecycle.
 *
 * Plan reference: V2 sections 4.2, 4.3; ADR-005, ADR-006.
 *
 * ## A published template is immutable
 *
 * Editing one would change how a historic submission renders, and a submission
 * has to stay renderable against the exact template that produced it — an
 * assessment defended years later must look the way it looked when it was
 * made. Changes go to a new version via `clone`.
 *
 * ## Validation happens at publish, not at save
 *
 * A draft may be half-finished. A published template is about to be put in
 * front of an officer, so that is where a circular formula reference or an
 * unparseable expression must be caught.
 */
@Injectable()
export class FormTemplateService {
  private readonly logger = new Logger(FormTemplateService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly validation: FormValidationService,
  ) {}

  async create(input: {
    categoryCode: string;
    templateCode: string;
    displayKey: string;
    definition: FormDefinition;
    appliesToYear?: string;
  }): Promise<FormTemplateRecord> {
    const categoryId = await this.categoryIdFor(input.categoryCode);

    const existing = await this.sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM forms.form_template WHERE template_code = :templateCode`,
      { type: QueryTypes.SELECT, replacements: { templateCode: input.templateCode } },
    );
    if (Number(existing[0]!.n) > 0) {
      throw new ConflictException(
        `Template '${input.templateCode}' already exists. Use clone to create a new version.`,
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO forms.form_template
              (category_id, template_code, version, display_key, definition,
               schema_version, status, applies_to_year, created_by)
       VALUES (:categoryId, :templateCode, 1, :displayKey, CAST(:definition AS jsonb),
               :schemaVersion, 'DRAFT', :appliesToYear, :userId)
       RETURNING id, uuid, template_code, version, display_key, status,
                 schema_version, applies_to_year, definition`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          categoryId,
          templateCode: input.templateCode,
          displayKey: input.displayKey,
          definition: JSON.stringify(input.definition),
          schemaVersion: input.definition.schemaVersion ?? '1.0.0',
          appliesToYear: input.appliesToYear ?? null,
          userId: currentUserId() ?? null,
        },
      },
    );
    return toTemplate(rows[0]!);
  }

  /** A draft may be edited freely. A published one may not. */
  async updateDraft(id: number, definition: FormDefinition): Promise<FormTemplateRecord> {
    const current = await this.findById(id);
    if (current.status !== 'DRAFT') {
      throw new ConflictException(
        `Template ${current.templateCode} v${current.version} is ${current.status} and cannot ` +
          `be edited. Clone it to make a new version.`,
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE forms.form_template
          SET definition = CAST(:definition AS jsonb),
              schema_version = :schemaVersion,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = :userId
        WHERE id = :id
        RETURNING id, uuid, template_code, version, display_key, status,
                  schema_version, applies_to_year, definition`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id,
          definition: JSON.stringify(definition),
          schemaVersion: definition.schemaVersion ?? '1.0.0',
          userId: currentUserId() ?? null,
        },
      },
    );
    return toTemplate(rows[0]!);
  }

  /**
   * Publish a draft, after validating it.
   *
   * A circular formula reference is an infinite loop the first time an officer
   * opens the form. Catching it here means a broken template never reaches
   * one.
   */
  async publish(id: number): Promise<FormTemplateRecord> {
    const template = await this.findById(id);
    if (template.status === 'PUBLISHED') {
      return template;
    }
    if (template.status === 'ARCHIVED') {
      throw new ConflictException('An archived template cannot be republished');
    }

    const outcome = this.validation.validateDefinition(template.definition);
    if (!outcome.valid) {
      throw new BadRequestException({
        message: 'The template cannot be published',
        problems: outcome.problems,
      });
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE forms.form_template
          SET status = 'PUBLISHED',
              published_at = CURRENT_TIMESTAMP,
              published_by = :userId,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
        RETURNING id, uuid, template_code, version, display_key, status,
                  schema_version, applies_to_year, definition`,
      { type: QueryTypes.SELECT, replacements: { id, userId: currentUserId() ?? null } },
    );

    this.logger.log(`Published ${template.templateCode} v${template.version}`);
    return toTemplate(rows[0]!);
  }

  /**
   * Clone to a new draft version.
   *
   * The clone-per-year mechanism (plan 4.3). `derived_from_template_id` keeps
   * the family queryable rather than discoverable only by naming convention.
   */
  async clone(id: number, appliesToYear?: string): Promise<FormTemplateRecord> {
    const source = await this.findById(id);

    const maxVersion = await this.sequelize.query<{ max: string | null }>(
      `SELECT max(version)::text AS max FROM forms.form_template
        WHERE template_code = :templateCode`,
      { type: QueryTypes.SELECT, replacements: { templateCode: source.templateCode } },
    );
    const nextVersion = Number(maxVersion[0]?.max ?? 0) + 1;

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO forms.form_template
              (category_id, template_code, version, display_key, definition,
               schema_version, status, derived_from_template_id, applies_to_year, created_by)
       SELECT category_id, template_code, :nextVersion, display_key, definition,
              schema_version, 'DRAFT', id, :appliesToYear, :userId
         FROM forms.form_template WHERE id = :id
       RETURNING id, uuid, template_code, version, display_key, status,
                 schema_version, applies_to_year, definition`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id,
          nextVersion,
          appliesToYear: appliesToYear ?? source.appliesToYear ?? null,
          userId: currentUserId() ?? null,
        },
      },
    );
    return toTemplate(rows[0]!);
  }

  async findById(id: number): Promise<FormTemplateRecord> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, uuid, template_code, version, display_key, status,
              schema_version, applies_to_year, definition
         FROM forms.form_template WHERE id = :id AND is_active`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such form template');
    }
    return toTemplate(row);
  }

  /**
   * The published template for a code, optionally for a given year.
   *
   * This is what a workflow step resolves to render its form.
   */
  async findPublished(templateCode: string, appliesToYear?: string): Promise<FormTemplateRecord> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, uuid, template_code, version, display_key, status,
              schema_version, applies_to_year, definition
         FROM forms.form_template
        WHERE template_code = :templateCode
          AND status = 'PUBLISHED'
          AND is_active
          AND (:appliesToYear::text IS NULL OR applies_to_year = :appliesToYear)
        ORDER BY version DESC
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { templateCode, appliesToYear: appliesToYear ?? null },
      },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(
        `No published template '${templateCode}'` +
          (appliesToYear === undefined ? '' : ` for ${appliesToYear}`),
      );
    }
    return toTemplate(row);
  }

  async list(categoryCode?: string): Promise<readonly FormTemplateRecord[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT t.id, t.uuid, t.template_code, t.version, t.display_key, t.status,
              t.schema_version, t.applies_to_year, t.definition
         FROM forms.form_template t
         JOIN forms.form_category c ON c.id = t.category_id
        WHERE t.is_active
          AND (:categoryCode::text IS NULL OR c.category_code = :categoryCode)
        ORDER BY t.template_code, t.version DESC`,
      { type: QueryTypes.SELECT, replacements: { categoryCode: categoryCode ?? null } },
    );
    return rows.map(toTemplate);
  }

  private async categoryIdFor(categoryCode: string): Promise<number> {
    const rows = await this.sequelize.query<{ id: string }>(
      `SELECT id FROM forms.form_category WHERE category_code = :categoryCode AND is_active`,
      { type: QueryTypes.SELECT, replacements: { categoryCode } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`No such form category '${categoryCode}'`);
    }
    return Number(row.id);
  }
}

function toTemplate(row: Record<string, unknown>): FormTemplateRecord {
  return {
    id: Number(row['id']),
    uuid: String(row['uuid']),
    templateCode: String(row['template_code']),
    version: Number(row['version']),
    displayKey: String(row['display_key']),
    status: String(row['status']) as TemplateStatus,
    schemaVersion: String(row['schema_version']),
    appliesToYear: row['applies_to_year'] === null ? undefined : String(row['applies_to_year']),
    definition: row['definition'] as FormDefinition,
  };
}
