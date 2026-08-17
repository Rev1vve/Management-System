import { Controller, Get, Inject } from '@nestjs/common';

import { AppService, type ServiceStatus } from './app.service';

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService) {}

  @Get()
  getRoot(): ServiceStatus {
    return this.appService.getStatus();
  }
}
