import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AppService, type HealthStatus, type ServiceStatus } from './app.service';

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService) {}

  @Get()
  getRoot(): ServiceStatus {
    return this.appService.getStatus();
  }

  /** 公开存活探针：部署与重启验收用，不需要登录，也不泄漏内部细节。 */
  @Get('health')
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<HealthStatus> {
    const health = await this.appService.getHealth();
    if (health.database !== 'up') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }
}
