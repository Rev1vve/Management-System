import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';

/**
 * Integration tests for the audit trail: auth events are recorded with actor,
 * action, resource and result, and sensitive material (passwords, tokens,
 * TOTP secrets, recovery codes) never reaches the summary (plan line 401).
 */
const prisma = new PrismaService();

const TABLES = ['audit_logs', 'users'];

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

let service: AuditService;
let actorId: string;

beforeAll(async () => {
  service = new AuditService(prisma);
});

beforeEach(async () => {
  await truncateAll();
  const user = await prisma.user.create({
    data: {
      account: 'auditor',
      name: '审计员',
      workEmail: 'auditor@example.test',
      status: 'ACTIVE',
    },
  });
  actorId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('AuditService', () => {
  it('records an auth event with actor, action, resource and result', async () => {
    await service.record({
      actorId,
      action: 'auth.login.success',
      resourceType: 'session',
      resourceId: 'session-1',
      result: 'success',
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { actorId, action: 'auth.login.success' },
    });
    expect(row.resourceType).toBe('session');
    expect(row.resourceId).toBe('session-1');
    expect(row.result).toBe('success');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('supports an unauthenticated actor (null actorId)', async () => {
    await service.record({
      actorId: null,
      action: 'auth.login.failed',
      resourceType: 'user',
      resourceId: 'unknown',
      result: 'failure',
    });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login.failed' },
    });
    expect(row.actorId).toBeNull();
  });

  it('records project-scoped events', async () => {
    await service.record({
      actorId,
      action: 'worklog.submitted',
      resourceType: 'work_log_version',
      resourceId: 'wlv-1',
      projectId: 'prj-1',
      result: 'success',
      summary: '提交了工作日志',
    });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'worklog.submitted' },
    });
    expect(row.projectId).toBe('prj-1');
    expect(row.summary).toBe('提交了工作日志');
  });

  it('never stores sensitive material in the summary', async () => {
    // A buggy caller passes a summary containing a raw password; the service
    // must redact it instead of persisting it.
    await service.record({
      actorId,
      action: 'auth.login.failed',
      resourceType: 'user',
      resourceId: actorId,
      result: 'failure',
      summary: 'wrong password attempted: super-secret-pass-12345',
    });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login.failed' },
    });
    expect(row.summary).not.toContain('super-secret-pass-12345');
    expect(row.summary).toContain('[REDACTED]');
  });

  it('accepts an explicit summary flag to skip redaction for safe values', async () => {
    await service.record({
      actorId,
      action: 'user.suspended',
      resourceType: 'user',
      resourceId: actorId,
      result: 'success',
      summary: '账号已停用',
      redactSensitive: false,
    });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.suspended' },
    });
    expect(row.summary).toBe('账号已停用');
  });
});
