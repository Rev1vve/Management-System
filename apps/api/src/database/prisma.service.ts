import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

/**
 * Application-scoped Prisma client backed by the `@prisma/adapter-pg` driver
 * adapter (required by Prisma 7's Rust-free query compiler for PostgreSQL).
 *
 * The connection string is read from `DATABASE_URL` at construction time and
 * must point at the PostgreSQL instance on the private Compose network.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required to connect PrismaService to PostgreSQL');
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
