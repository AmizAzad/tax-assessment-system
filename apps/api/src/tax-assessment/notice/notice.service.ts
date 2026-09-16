import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { DocumentService } from '../../platform/document/document.service';
import { CaseService } from '../case/case.service';
import { DeadlineService } from '../deadline/deadline.service';
import {
  NoticeRenderError,
  hashContent,
  renderNotice,
  renderPdf,
  tokensIn,
} from './notice-renderer';

export interface GenerateNoticeInput {
  readonly noticeType: string;
  readonly languageCode?: string;
}

export interface NoticeRecord {
  readonly id: number;
  readonly uuid: string;
  readonly caseId: number;
  readonly noticeNumber: string;
  readonly noticeType: string;
  readonly version: number;
  readonly languageCode: string;
  readonly status: string;
  readonly contentHash: string;
  readonly title: string;
  readonly body: string;
  readonly documentUuid: string | null;
  readonly issuedAt: Date | null;
  readonly firstServedAt: Date | null;
  readonly deemedServedOn: string | null;
}

/**
 * Producing the legal instrument.
 *
 * Plan reference: V2 sections 12.1 to 12.4 (Phase 5).
 *
 * ## The pipeline
 *
 * Resolve the wording, gather the facts from the approved calculation,
 * substitute, hash the content, render a PDF, store it, record the notice, and
 * move the case. Each step can fail loudly; none of them guesses.
 *
 * ## Why the facts come from the stored calculation
 *
 * Not from a fresh one. The notice states the figure an approver signed off.
 * Recomputing at notice time could produce a different number if anything
 * moved underneath, and the taxpayer would receive a demand nobody approved.
 *
 * ## Why a notice cannot be generated before finalisation
 *
 * A notice is the act that makes a determination operative against a person.
 * Issuing one from a draft assessment would give legal effect to a figure that
 * has not been through review and approval.
 */
@Injectable()
export class NoticeService {
  private readonly logger = new Logger(NoticeService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly documents: DocumentService,
    private readonly deadlines: DeadlineService,
  ) {}

  /**
   * Generate a notice for a case.
   *
   * Re-generating produces a new version rather than overwriting: the taxpayer
   * may be holding the previous one, and "which notice did they receive" must
   * stay answerable.
   */
  async generate(
    caseId: number,
    input: GenerateNoticeInput,
    caller: RequestContext,
  ): Promise<NoticeRecord> {
    const assessmentCase = await this.cases.findById(caseId);

    if (!canIssueNoticeFrom(assessmentCase.statusCode)) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. A notice gives legal ` +
          'effect to a determination, so it may only be issued once the assessment is finalised.',
      );
    }

    const template = await this.resolveTemplate(
      assessmentCase.jurisdictionCode,
      input.noticeType,
      input.languageCode ?? 'en',
    );

    const { values, calculationResultId } = await this.gatherFacts(
      assessmentCase,
      input.noticeType,
    );

    let rendered;
    try {
      rendered = renderNotice(template.title_template, template.body_template, values);
    } catch (error) {
      if (error instanceof NoticeRenderError) {
        // A configuration fault, not a server fault: somebody published a
        // template referencing a value this system does not produce.
        throw new ConflictException(
          `Notice template ${template.id} cannot be rendered for case ` +
            `${assessmentCase.caseNumber}. ${error.message}`,
        );
      }
      throw error;
    }

    return this.sequelize.transaction(async (transaction) => {
      const version = await this.nextVersion(caseId, input.noticeType, transaction);
      const noticeNumber = `${assessmentCase.caseNumber}-${input.noticeType}-${String(version).padStart(2, '0')}`;

      // The PDF is a rendering of the notice, so a script it cannot draw must
      // not block the notice itself from existing. The content is the record.
      let documentId: number | null = null;
      let documentUuid: string | null = null;
      try {
        const pdf = await renderPdf(rendered, noticeNumber);
        const document = await this.documents.upload({
          filename: `${noticeNumber}.pdf`,
          contentType: 'application/pdf',
          body: pdf,
          ownerType: 'ASSESSMENT_NOTICE',
          ownerId: caseId,
          classification: 'OFFICIAL',
          retentionClass: 'STATUTORY',
        });
        documentId = document.id;
        documentUuid = document.uuid;
      } catch (error) {
        if (error instanceof NoticeRenderError) {
          this.logger.warn(
            `Notice ${noticeNumber} has no PDF rendering: ${error.message} ` +
              'The notice content is stored and can be served through the portal.',
          );
        } else {
          throw error;
        }
      }

      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_assessment_notice
                (case_id, notice_number, notice_type, version, language_code, template_id,
                 calculation_result_id, content_json, rendered_title, rendered_body,
                 content_hash, document_id, status, issued_at, issued_by,
                 created_at, created_by, updated_at, updated_by, is_active)
         VALUES (:caseId, :noticeNumber, :noticeType, :version, :language, :templateId,
                 :calculationResultId, :content, :title, :body,
                 :hash, :documentId, 'ISSUED', CURRENT_TIMESTAMP, :userId,
                 CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId,
            noticeNumber,
            noticeType: input.noticeType,
            version,
            language: input.languageCode ?? 'en',
            templateId: template.id,
            calculationResultId,
            content: JSON.stringify(rendered.content),
            title: rendered.title,
            body: rendered.body,
            hash: rendered.contentHash,
            documentId,
            userId: caller.userId ?? null,
          },
        },
      );

      const record = toNotice(rows[0]!, documentUuid);

      // GENERATE_NOTICE is SYSTEM-only: the notice existing is a fact, not a
      // claim an officer makes. Only the first notice moves the case; a
      // re-issue leaves the status where it is.
      if (assessmentCase.statusCode === CaseStatus.FINALISED) {
        await this.cases.transition(
          caseId,
          'GENERATE_NOTICE',
          { ...caller, roleCodes: [RoleCode.SYSTEM] },
          { noticeNumber, noticeType: input.noticeType, version },
        );
      }

      this.logger.log(`Issued notice ${noticeNumber} for case ${assessmentCase.caseNumber}`);
      return record;
    });
  }

  /**
   * Does this notice still say what it said when it was served?
   *
   * Recomputes the hash from the stored content. A mismatch means the stored
   * text was altered after issue, which is the thing an audit needs to be able
   * to rule out.
   */
  async verify(uuid: string): Promise<{
    readonly noticeNumber: string;
    readonly intact: boolean;
    readonly storedHash: string;
    readonly recomputedHash: string;
    readonly checkedAt: string;
  }> {
    const notice = await this.findRow(uuid);

    const recomputed = hashContent(
      String(notice['rendered_title']),
      String(notice['rendered_body']),
      (notice['content_json'] ?? {}) as Record<string, string>,
    );
    const stored = String(notice['content_hash']);

    if (recomputed !== stored) {
      this.logger.error(
        `Notice ${String(notice['notice_number'])} failed verification: stored ${stored}, ` +
          `recomputed ${recomputed}. The stored content has been altered since issue.`,
      );
    }

    return {
      noticeNumber: String(notice['notice_number']),
      intact: recomputed === stored,
      storedHash: stored,
      recomputedHash: recomputed,
      checkedAt: new Date().toISOString(),
    };
  }

  async findByUuid(uuid: string): Promise<NoticeRecord> {
    const row = await this.findRow(uuid);
    const documentUuid = await this.documentUuidFor(row['document_id'] as number | null);
    return toNotice(row, documentUuid);
  }

  async listForCase(caseId: number): Promise<readonly NoticeRecord[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT n.*, d.uuid AS document_uuid
         FROM tax.tax_assessment_notice n
         LEFT JOIN platform.document d ON d.id = n.document_id
        WHERE n.case_id = :caseId AND n.is_active
        ORDER BY n.notice_type, n.version DESC`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    return rows.map((row) => toNotice(row, (row['document_uuid'] as string | null) ?? null));
  }

  /** The rendered PDF. */
  async documentFor(uuid: string): Promise<{ filename: string; body: Buffer }> {
    const row = await this.findRow(uuid);
    const documentId = row['document_id'] as number | null;
    if (documentId === null) {
      throw new NotFoundException(
        `Notice ${String(row['notice_number'])} has no rendered document. Its content is ` +
          'available through the notice endpoint.',
      );
    }
    const documentUuid = await this.documentUuidFor(documentId);
    const downloaded = await this.documents.download(documentUuid!);
    return { filename: downloaded.record.filename, body: downloaded.body };
  }

  /** Notice wording templates, for the administration screen. */
  async templates(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT id, jurisdiction_code, notice_type, language_code, version, status,
              title_template, required_tokens, effective_from, effective_to
         FROM tax.tax_notice_template
        WHERE is_active
          AND (:jurisdiction::text IS NULL OR jurisdiction_code = :jurisdiction)
        ORDER BY jurisdiction_code, notice_type, language_code`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdiction ?? null } },
    );
  }

  /**
   * Publish a template.
   *
   * Checks the tokens it uses against what the system can supply. A template
   * that references a value nothing produces would fail at the moment an
   * officer tries to issue a notice, which is the worst time to discover it.
   */
  async publishTemplate(id: number, caller: RequestContext): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_notice_template WHERE id = :id AND is_active`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    const template = rows[0];
    if (template === undefined) {
      throw new NotFoundException(`Notice template ${id} was not found.`);
    }

    const used = new Set([
      ...tokensIn(String(template['title_template'])),
      ...tokensIn(String(template['body_template'])),
    ]);
    const unsupported = [...used].filter((token) => !SUPPLIED_TOKENS.has(token)).sort();

    if (unsupported.length > 0) {
      throw new ConflictException(
        `The template uses tokens this system does not supply: ${unsupported.join(', ')}. ` +
          `Supported tokens are: ${[...SUPPLIED_TOKENS].sort().join(', ')}.`,
      );
    }

    const updated = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE tax.tax_notice_template
          SET status = 'PUBLISHED', required_tokens = :tokens,
              updated_at = CURRENT_TIMESTAMP, updated_by = :userId
        WHERE id = :id
        RETURNING id, notice_type, language_code, status, required_tokens`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id,
          tokens: JSON.stringify([...used].sort()),
          userId: caller.userId ?? null,
        },
      },
    );
    return updated[0] ?? {};
  }

  // ------------------------------------------------------------------ internals

  private async findRow(uuid: string): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_assessment_notice WHERE uuid = :uuid AND is_active`,
      { type: QueryTypes.SELECT, replacements: { uuid } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Notice ${uuid} was not found.`);
    }
    return row;
  }

  private async documentUuidFor(documentId: number | null): Promise<string | null> {
    if (documentId === null) return null;
    const rows = await this.sequelize.query<{ uuid: string }>(
      `SELECT uuid FROM platform.document WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: documentId } },
    );
    return rows[0]?.uuid ?? null;
  }

  private async resolveTemplate(
    jurisdictionCode: string,
    noticeType: string,
    languageCode: string,
  ): Promise<{ id: number; title_template: string; body_template: string }> {
    const rows = await this.sequelize.query<{
      id: number;
      title_template: string;
      body_template: string;
    }>(
      `SELECT id, title_template, body_template
         FROM tax.tax_notice_template
        WHERE jurisdiction_code = :jurisdiction
          AND notice_type = :noticeType
          AND language_code = :language
          AND status = 'PUBLISHED'
          AND is_active
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode, noticeType, language: languageCode },
      },
    );

    const template = rows[0];
    if (template === undefined) {
      // Falling back to another language would serve a notice in a language
      // the taxpayer did not choose, which is its own legal problem.
      throw new ConflictException(
        `No published ${noticeType} notice template for ${jurisdictionCode} in ` +
          `'${languageCode}'. Publish the wording before issuing notices.`,
      );
    }
    return template;
  }

  private async nextVersion(
    caseId: number,
    noticeType: string,
    transaction: Transaction,
  ): Promise<number> {
    const rows = await this.sequelize.query<{ max: string | null }>(
      `SELECT max(version)::text AS max
         FROM tax.tax_assessment_notice
        WHERE case_id = :caseId AND notice_type = :noticeType`,
      { type: QueryTypes.SELECT, transaction, replacements: { caseId, noticeType } },
    );
    return Number(rows[0]?.max ?? 0) + 1;
  }

  /**
   * The facts a notice states.
   *
   * Read from the stored calculation, never recomputed. Amounts are formatted
   * once, here, so every notice presents them the same way; the underlying
   * values stay exact strings all the way from the database (ADR-007).
   */
  private async gatherFacts(
    assessmentCase: {
      id: number;
      caseNumber: string;
      tin: string;
      taxpayerName: string;
      taxTypeCode: string;
      assessmentYear: string;
      jurisdictionCode: string;
      currencyCode: string;
    },
    noticeType: string,
  ): Promise<{ values: Record<string, string>; calculationResultId: number | null }> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, declared_base::text AS declared_base,
              total_adjustments::text AS total_adjustments,
              assessed_base::text AS assessed_base,
              losses_set_off::text AS losses_set_off,
              taxable_base::text AS taxable_base,
              tax_before_credits::text AS tax_before_credits,
              total_credits::text AS total_credits,
              tax_after_credits::text AS tax_after_credits,
              penalty_amount::text AS penalty_amount,
              interest_amount::text AS interest_amount,
              total_payable::text AS total_payable,
              net_payable_or_refundable::text AS net_payable_or_refundable,
              currency_code
         FROM tax.tax_calculation_result
        WHERE case_id = :caseId AND is_current`,
      { type: QueryTypes.SELECT, replacements: { caseId: assessmentCase.id } },
    );

    const result = rows[0];
    if (result === undefined) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} has no current calculation, so a notice would have ` +
          'no figure to state.',
      );
    }

    const currency = String(result['currency_code']);
    const amount = (column: string): string =>
      Money.of(String(result[column] ?? '0'), currency).toFixed(2);

    const paymentDeadline = await this.deadlines.resolve(
      assessmentCase,
      'PAYMENT',
      // Anchored on the period, like the original payment date. A notice does
      // not restart the payment clock; it states when the tax already fell due.
      `${assessmentCase.assessmentYear}-12-31`,
    );

    const values: Record<string, string> = {
      caseNumber: assessmentCase.caseNumber,
      noticeType,
      taxpayerName: assessmentCase.taxpayerName,
      tin: assessmentCase.tin,
      taxType: assessmentCase.taxTypeCode,
      assessmentYear: assessmentCase.assessmentYear,
      jurisdiction: assessmentCase.jurisdictionCode,
      currency,
      issueDate: new Date().toISOString().slice(0, 10),
      declaredBase: amount('declared_base'),
      totalAdjustments: amount('total_adjustments'),
      assessedBase: amount('assessed_base'),
      lossesSetOff: amount('losses_set_off'),
      taxableBase: amount('taxable_base'),
      taxBeforeCredits: amount('tax_before_credits'),
      totalCredits: amount('total_credits'),
      taxAfterCredits: amount('tax_after_credits'),
      penaltyAmount: amount('penalty_amount'),
      interestAmount: amount('interest_amount'),
      totalPayable: amount('total_payable'),
      netPayable: amount('net_payable_or_refundable'),
      paymentDueDate: paymentDeadline?.dueDate ?? 'on demand',
    };

    return { values, calculationResultId: Number(result['id']) };
  }
}

/**
 * The tokens a template may use.
 *
 * Checked at publish time. Keeping the list here rather than deriving it from
 * `gatherFacts` at runtime means an administrator gets told what is available
 * instead of discovering it by trial.
 */
const SUPPLIED_TOKENS = new Set([
  'caseNumber',
  'noticeType',
  'taxpayerName',
  'tin',
  'taxType',
  'assessmentYear',
  'jurisdiction',
  'currency',
  'issueDate',
  'declaredBase',
  'totalAdjustments',
  'assessedBase',
  'lossesSetOff',
  'taxableBase',
  'taxBeforeCredits',
  'totalCredits',
  'taxAfterCredits',
  'penaltyAmount',
  'interestAmount',
  'totalPayable',
  'netPayable',
  'paymentDueDate',
]);

/**
 * A notice may be issued from finalisation onward.
 *
 * The later statuses are included so a duplicate or corrected notice can be
 * re-issued on a case that has already been served, which happens whenever an
 * address turns out to be wrong.
 */
function canIssueNoticeFrom(status: string): boolean {
  const permitted: readonly string[] = [
    CaseStatus.FINALISED,
    CaseStatus.NOTICE_GENERATED,
    CaseStatus.NOTICE_SERVED,
    CaseStatus.AWAITING_TAXPAYER_RESPONSE,
    CaseStatus.UNDER_OBJECTION,
    CaseStatus.UNDER_APPEAL,
  ];
  return permitted.includes(status);
}

function toNotice(row: Record<string, unknown>, documentUuid: string | null): NoticeRecord {
  return {
    id: Number(row['id']),
    uuid: String(row['uuid']),
    caseId: Number(row['case_id']),
    noticeNumber: String(row['notice_number']),
    noticeType: String(row['notice_type']),
    version: Number(row['version']),
    languageCode: String(row['language_code']),
    status: String(row['status']),
    contentHash: String(row['content_hash']),
    title: String(row['rendered_title']),
    body: String(row['rendered_body']),
    documentUuid,
    issuedAt: (row['issued_at'] as Date | null) ?? null,
    firstServedAt: (row['first_served_at'] as Date | null) ?? null,
    deemedServedOn: (row['deemed_served_on'] as string | null) ?? null,
  };
}
