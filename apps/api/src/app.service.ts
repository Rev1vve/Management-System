import { Injectable } from '@nestjs/common';

export type ServiceStatus = Readonly<{
  service: 'project-operations-api';
  status: 'ok';
}>;

@Injectable()
export class AppService {
  getStatus(): ServiceStatus {
    return {
      service: 'project-operations-api',
      status: 'ok',
    };
  }
}
