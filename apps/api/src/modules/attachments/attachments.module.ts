import { Module } from '@nestjs/common';

import { AttachmentsController } from './attachments.controller';
import {
  ATTACHMENTS_ROOT,
  AttachmentsService,
  validateAttachmentsRoot,
} from './attachments.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [AuthorizationModule, CustomersModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    {
      provide: ATTACHMENTS_ROOT,
      useFactory: () => validateAttachmentsRoot(process.env.ATTACHMENTS_ROOT),
    },
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
