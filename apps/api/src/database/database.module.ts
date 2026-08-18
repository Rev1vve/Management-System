import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global database module exposing the PrismaService to every feature module.
 *
 * Note: this module is intentionally not yet registered in AppModule; it is
 * wired into the running application once the first database-backed feature
 * (identity and sessions, task 5) lands, so the minimal task-1/2 API keeps
 * booting without a live database.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
