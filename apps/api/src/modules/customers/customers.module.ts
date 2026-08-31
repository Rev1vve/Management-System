import { Module } from '@nestjs/common';

import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectAccessModule } from '../project-access/project-access.module';

@Module({
  imports: [AuthorizationModule, ProjectAccessModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
