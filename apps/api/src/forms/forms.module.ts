import { Module } from '@nestjs/common';
import { FormSubmissionService } from './form-submission.service';
import { FormTemplateService } from './form-template.service';
import { FormValidationService } from './form-validation.service';
import { FormsController } from './forms.controller';
import { ReferenceNumberService } from './reference-number.service';

/**
 * The DynaForms host.
 *
 * Owns categories, templates and submissions, and runs the form core
 * server-side (ADR-005) so that validation is one implementation rather than
 * two.
 */
@Module({
  controllers: [FormsController],
  providers: [
    FormValidationService,
    FormTemplateService,
    FormSubmissionService,
    ReferenceNumberService,
  ],
  exports: [
    FormValidationService,
    FormTemplateService,
    FormSubmissionService,
    ReferenceNumberService,
  ],
})
export class FormsModule {}
