import { Module } from '@nestjs/common';

import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectAccessModule } from '../project-access/project-access.module';

@Module({
  imports: [AuthorizationModule, ProjectAccessModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
