import { Module } from '@nestjs/common';

import { AttachmentsController } from './attachments.controller';
import { WorkLogAttachmentsController } from './work-log-attachments.controller';
import { WorkLogAttachmentsService } from './work-log-attachments.service';
import {
  ATTACHMENTS_ROOT,
  AttachmentsService,
  validateAttachmentsRoot,
} from './attachments.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [AuthorizationModule, CustomersModule],
  controllers: [AttachmentsController, WorkLogAttachmentsController],
  providers: [
    AttachmentsService,
    WorkLogAttachmentsService,
    {
      provide: ATTACHMENTS_ROOT,
      useFactory: () => validateAttachmentsRoot(process.env.ATTACHMENTS_ROOT),
    },
  ],
  exports: [AttachmentsService, WorkLogAttachmentsService],
})
export class AttachmentsModule {}
