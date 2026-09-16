import { Global, Module } from '@nestjs/common';
import { EntityHistoryService } from './entity-history.service';

/**
 * Field-level audit.
 *
 * Global because any module that writes a registered table needs it. The
 * domain event ledger (tax.tax_assessment_event) is separate and is the audit
 * system of record; this is the "who changed this field" layer.
 */
@Global()
@Module({
  providers: [EntityHistoryService],
  exports: [EntityHistoryService],
})
export class AuditModule {}
