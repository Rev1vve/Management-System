import { Injectable } from '@nestjs/common';

import { PrismaService } from './database/prisma.service';

export type ServiceStatus = Readonly<{
  service: 'project-operations-api';
  status: 'ok';
}>;

export type HealthStatus = Readonly<{
  service: 'project-operations-api';
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
}>;

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getStatus(): ServiceStatus {
    return {
      service: 'project-operations-api',
      status: 'ok',
    };
  }

  /**
   * 存活探针：部署脚本与"重启自恢复"验收都靠它。
   * 只做一次 SELECT 1，不查业务表，避免把探针变成压测。
   * 数据库不可用时返回 degraded，由控制器映射成 503（fail-closed：
   * 别让"进程还活着但连不上库"被当成部署成功）。
   */
  async getHealth(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { service: 'project-operations-api', status: 'ok', database: 'up' };
    } catch {
      return { service: 'project-operations-api', status: 'degraded', database: 'down' };
    }
  }
}
