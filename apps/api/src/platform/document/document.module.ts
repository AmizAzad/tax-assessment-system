import { Global, Module } from '@nestjs/common';
import { DocumentController } from './document.controller';
import { DocumentStorage } from './document-storage';
import { DocumentService } from './document.service';

/** Evidence, notices and attachments. Global: most domain modules attach files. */
@Global()
@Module({
  controllers: [DocumentController],
  providers: [DocumentStorage, DocumentService],
  exports: [DocumentStorage, DocumentService],
})
export class DocumentModule {}
