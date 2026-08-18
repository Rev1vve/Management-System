import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Database-level integration tests for the task-4 data model.
 *
 * These require a real PostgreSQL reachable via DATABASE_URL (the private
 * Compose network). They verify the CHECK constraints, soft-delete columns,
 * unique business numbers, UTC timestamp storage, optimistic-concurrency
 * version field, and the approver != submitter self-approval prohibition.
 *
 * Not part of the fast `pnpm test` unit suite; run via `pnpm test:integration`
 * inside the disposable verification network.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for integration tests');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const TABLES = [
  'audit_logs',
  'notifications',
  'attachments',
  'project_events',
  'approval_decisions',
  'approval_requests',
  'work_log_versions',
  'work_logs',
  'order_items',
  'orders',
  'project_membership_roles',
  'project_memberships',
  'portfolio_memberships',
  'projects',
  'customer_contacts',
  'portfolios',
  'customers',
  'role_permissions',
  'user_system_roles',
  'permissions',
  'system_roles',
  'mfa_recovery_codes',
  'sessions',
  'invitations',
  'users',
  'email_outbox',
  'system_settings',
];

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

async function createUser(account: string): Promise<{ id: string }> {
  return prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test` },
  });
}

describe('task 4 data model', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('CHECK constraints', () => {
    it('rejects negative work-log hours', async () => {
      const user = await createUser('hours_user');
      const project = await prisma.project.create({
        data: { number: 'PRJ-HOURS', name: 'hours' },
      });
      const workLog = await prisma.workLog.create({
        data: { number: 'WL-HOURS', authorId: user.id, projectId: project.id },
      });

      await expect(
        prisma.workLogVersion.create({
          data: {
            workLogId: workLog.id,
            versionNumber: 1,
            workDate: new Date('2026-08-18'),
            hours: -1,
            completion: 'negative hours',
            submittedById: user.id,
          },
        }),
      ).rejects.toThrow(/hours_non_negative/);
    });

    it('rejects completion percentage outside 0..100', async () => {
      await expect(
        prisma.project.create({
          data: { number: 'PRJ-PCT', name: 'pct', completionPercent: 101 },
        }),
      ).rejects.toThrow(/completion_percent_range/);

      await expect(
        prisma.project.create({
          data: { number: 'PRJ-PCT-NEG', name: 'pct', completionPercent: -1 },
        }),
      ).rejects.toThrow(/completion_percent_range/);
    });

    it('rejects negative order-item quantity', async () => {
      const project = await prisma.project.create({
        data: { number: 'PRJ-QTY', name: 'qty' },
      });
      const order = await prisma.order.create({
        data: { number: 'ORD-QTY', projectId: project.id, title: 'qty' },
      });

      await expect(
        prisma.orderItem.create({
          data: { orderId: order.id, name: 'item', quantity: -1 },
        }),
      ).rejects.toThrow(/quantity_non_negative/);
    });
  });

  describe('approval self-approval prohibition', () => {
    it('rejects approver equal to submitter', async () => {
      const approver = await createUser('self_approver');
      const submitter = approver;
      const project = await prisma.project.create({
        data: { number: 'PRJ-SELF', name: 'self' },
      });
      const workLog = await prisma.workLog.create({
        data: { number: 'WL-SELF', authorId: submitter.id, projectId: project.id },
      });
      const version = await prisma.workLogVersion.create({
        data: {
          workLogId: workLog.id,
          versionNumber: 1,
          workDate: new Date('2026-08-18'),
          hours: 1,
          completion: 'done',
          submittedById: submitter.id,
        },
      });

      await expect(
        prisma.approvalRequest.create({
          data: {
            workLogVersionId: version.id,
            approverId: approver.id,
            submitterId: submitter.id,
          },
        }),
      ).rejects.toThrow(/no_self_approval/);
    });

    it('allows approver distinct from submitter', async () => {
      const approver = await createUser('distinct_approver');
      const submitter = await createUser('distinct_submitter');
      const project = await prisma.project.create({
        data: { number: 'PRJ-DISTINCT', name: 'distinct' },
      });
      const workLog = await prisma.workLog.create({
        data: { number: 'WL-DISTINCT', authorId: submitter.id, projectId: project.id },
      });
      const version = await prisma.workLogVersion.create({
        data: {
          workLogId: workLog.id,
          versionNumber: 1,
          workDate: new Date('2026-08-18'),
          hours: 1,
          completion: 'done',
          submittedById: submitter.id,
        },
      });

      const request = await prisma.approvalRequest.create({
        data: {
          workLogVersionId: version.id,
          approverId: approver.id,
          submitterId: submitter.id,
        },
      });
      expect(request.status).toBe('PENDING');
    });
  });

  describe('unique business numbers', () => {
    it('enforces unique customer number', async () => {
      await prisma.customer.create({ data: { number: 'CUST-DUP', name: 'a' } });
      await expect(
        prisma.customer.create({ data: { number: 'CUST-DUP', name: 'b' } }),
      ).rejects.toThrow();
    });

    it('enforces unique project number', async () => {
      await prisma.project.create({ data: { number: 'PRJ-DUP', name: 'a' } });
      await expect(
        prisma.project.create({ data: { number: 'PRJ-DUP', name: 'b' } }),
      ).rejects.toThrow();
    });

    it('enforces unique order number', async () => {
      const project = await prisma.project.create({
        data: { number: 'PRJ-ORD-DUP', name: 'p' },
      });
      await prisma.order.create({
        data: { number: 'ORD-DUP', projectId: project.id, title: 'a' },
      });
      await expect(
        prisma.order.create({
          data: { number: 'ORD-DUP', projectId: project.id, title: 'b' },
        }),
      ).rejects.toThrow();
    });

    it('enforces unique work-log number', async () => {
      const user = await createUser('wl_dup_user');
      const project = await prisma.project.create({
        data: { number: 'PRJ-WL-DUP', name: 'p' },
      });
      await prisma.workLog.create({
        data: { number: 'WL-DUP', authorId: user.id, projectId: project.id },
      });
      await expect(
        prisma.workLog.create({
          data: { number: 'WL-DUP', authorId: user.id, projectId: project.id },
        }),
      ).rejects.toThrow();
    });
  });

  describe('soft delete', () => {
    it('supports soft delete via deleted_at without removing the row', async () => {
      const customer = await prisma.customer.create({
        data: { number: 'CUST-SOFT', name: 'soft' },
      });
      const now = new Date('2026-08-18T00:00:00.000Z');

      const updated = await prisma.customer.update({
        where: { id: customer.id },
        data: { deletedAt: now },
      });
      expect(updated.deletedAt?.toISOString()).toBe(now.toISOString());

      // The row still exists physically (soft delete, not hard delete).
      const found = await prisma.customer.findUnique({ where: { id: customer.id } });
      expect(found).not.toBeNull();
      expect(found?.deletedAt).not.toBeNull();
    });
  });

  describe('version field', () => {
    it('defaults the optimistic-concurrency version to 1', async () => {
      const customer = await prisma.customer.create({
        data: { number: 'CUST-VER', name: 'ver' },
      });
      expect(customer.version).toBe(1);
    });
  });

  describe('UTC timestamp storage', () => {
    it('round-trips a timestamp as the same UTC instant', async () => {
      const instant = new Date('2026-08-18T07:30:00.000Z');
      // Write a known instant into a controllable timestamptz column and read
      // it back: the stored instant must round-trip without drift or truncation.
      const customer = await prisma.customer.create({
        data: { number: 'CUST-UTC', name: 'utc', deletedAt: instant },
      });

      const read = await prisma.customer.findUnique({
        where: { id: customer.id },
      });
      expect(read).not.toBeNull();
      expect(read!.deletedAt?.getTime()).toBe(instant.getTime());

      // Business dates use the `date` type (no time component): a full UTC
      // instant stored as a business date round-trips as its calendar date.
      const project = await prisma.project.create({
        data: {
          number: 'PRJ-UTC',
          name: 'utc',
          startDate: new Date('2026-08-18T00:00:00.000Z'),
        },
      });
      expect(project.startDate).not.toBeNull();
      expect(project.startDate!.toISOString().slice(0, 10)).toBe('2026-08-18');
    });
  });
});
