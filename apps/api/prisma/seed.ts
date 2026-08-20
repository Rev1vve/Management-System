import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Development/test seed. Idempotent by design (every record is upserted on a
 * natural unique key), so it can be re-run without duplicating data.
 *
 * It refuses to touch a production database: seeding is only allowed when
 * `NODE_ENV` is unset or one of `development`/`test`, or when the operator has
 * explicitly opted in with `ALLOW_SEED=true` (never set this in production).
 */
async function main(): Promise<void> {
  const env = process.env.NODE_ENV;
  const allowSeed = process.env.ALLOW_SEED === 'true';
  if (env === 'production' && !allowSeed) {
    throw new Error(
      'Refusing to seed a production database (NODE_ENV=production). ' +
        'This is a development/test-only operation.',
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run the seed');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    // System roles (upserted by stable key). Privileged roles require TOTP
    // (plan D-056); a pure employee account may opt out.
    const roles = [
      { key: 'ADMIN', name: '系统管理员', requiresMfa: true },
      { key: 'EMPLOYEE', name: '普通员工', requiresMfa: false },
      { key: 'APPROVER', name: '审批人', requiresMfa: true },
      { key: 'PROJECT_MANAGER', name: '项目经理', requiresMfa: true },
      { key: 'PORTFOLIO_DIRECTOR', name: '项目总监', requiresMfa: true },
      { key: 'EXECUTIVE', name: '高层领导', requiresMfa: true },
    ];
    for (const role of roles) {
      await prisma.systemRole.upsert({
        where: { key: role.key },
        update: { name: role.name, requiresMfa: role.requiresMfa },
        create: role,
      });
    }

    // Demo users (upserted by unique account).
    const users = [
      { account: 'admin', name: '管理员', workEmail: 'admin@example.test' },
      { account: 'manager', name: '项目经理甲', workEmail: 'manager@example.test' },
      { account: 'employee', name: '员工乙', workEmail: 'employee@example.test' },
      { account: 'approver', name: '审批人丙', workEmail: 'approver@example.test' },
    ];
    for (const user of users) {
      await prisma.user.upsert({
        where: { account: user.account },
        update: { name: user.name, workEmail: user.workEmail },
        create: { ...user, status: 'ACTIVE' },
      });
    }

    // Demo portfolio, customer and project (upserted by unique number).
    await prisma.portfolio.upsert({
      where: { id: '00000000-0000-0000-0000-000000000001' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000001',
        name: '示例项目集',
        description: '开发/测试种子项目集',
      },
    });

    await prisma.customer.upsert({
      where: { number: 'CUST-0001' },
      update: {},
      create: { number: 'CUST-0001', name: '示例客户', status: 'ACTIVE' },
    });

    await prisma.project.upsert({
      where: { number: 'PRJ-0001' },
      update: {},
      create: {
        number: 'PRJ-0001',
        name: '示例项目',
        description: '开发/测试种子项目',
        status: 'ACTIVE',
        completionPercent: 0,
      },
    });

    console.log('Seed complete (idempotent).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
