import { Module } from '@nestjs/common';

import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';
import { AuthorizationModule } from '../authorization/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [PortfoliosController],
  providers: [PortfoliosService],
  exports: [PortfoliosService],
})
export class PortfoliosModule {}
