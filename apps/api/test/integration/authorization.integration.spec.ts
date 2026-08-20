import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { RolesService } from '../../src/modules/roles/roles.service';
import { SessionGuard } from '../../src/modules/auth/session.guard';
import { PermissionsGuard } from '../../src/modules/authorization/permissions.guard';
import {
  PERMISSION_DESCRIPTIONS,
  ROLE_DEFINITIONS,
  type SystemRoleKey,
} from '../../src/modules/authorization/permission.constants';
import { randomToken, sha256Hex } from '../../src/crypto/token.util';
import { TestAuthController } from '../../src/testing/test-auth.controller';

/**
 * Integration tests for the system-level permission kernel (plan task 6):
 * HTTP semantics of PermissionsGuard over a real session cookie chain.
 *
 * The fixture seeds system roles, permissions and role -> permission links
 * directly from ROLE_DEFINITIONS (single source of truth), so the matrix the
 * tests assert against cannot drift from the seed.
 */
const prisma = new PrismaService();

const TABLES = [
  'audit_logs',
  'notifications',
  'email_outbox',
  'mfa_recovery_codes',
  'sessions',
  'invitations',
  'user_system_roles',
  'role_permissions',
  'permissions',
  'system_roles',
  'users',
];

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

let app: INestApplication;
let sessions: SessionsService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [TestAuthController],
    providers: [PrismaService, SessionsService, RolesService, SessionGuard, PermissionsGuard],
  }).compile();

  app = moduleRef.createNestApplication();
  // SessionGuard reads request.cookies, which requires the same
  // cookie-parser middleware the real main.ts wires up.
  app.use(cookieParser());
  await app.init();
  sessions = moduleRef.get(SessionsService);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Creates a system role (with its matrix permissions) by stable key. */
async function createRole(key: SystemRoleKey): Promise<string> {
  const def = ROLE_DEFINITIONS.find((r) => r.key === key);
  if (!def) throw new Error(`Unknown role ${key}`);
  const role = await prisma.systemRole.upsert({
    where: { key },
    update: {},
    create: { key, name: def.name, requiresMfa: def.requiresMfa },
  });
  for (const p of def.permissions) {
    const permission = await prisma.permission.upsert({
      where: { key: p },
      update: {},
      create: { key: p, description: PERMISSION_DESCRIPTIONS[p] },
    });
    await prisma.rolePermission.upsert({
      where: {
        systemRoleId_permissionId: {
          systemRoleId: role.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: { systemRoleId: role.id, permissionId: permission.id },
    });
  }
  return role.id;
}

async function createUserWithRoles(account: string, roleKeys: SystemRoleKey[]): Promise<string> {
  const user = await prisma.user.create({
    data: {
      account,
      name: account,
      workEmail: `${account}@example.test`,
      status: 'ACTIVE',
    },
  });
  for (const key of roleKeys) {
    const roleId = await createRole(key);
    await prisma.userSystemRole.create({
      data: { userId: user.id, systemRoleId: roleId },
    });
  }
  return user.id;
}

/** Creates an ACTIVE session for the user and returns the raw cookie token. */
async function sessionCookie(userId: string): Promise<string> {
  const token = randomToken(32);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

function http() {
  return request(app.getHttpServer());
}

describe('PermissionsGuard (HTTP)', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await http().get('/test-auth/audit');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown cookie token', async () => {
    const res = await http().get('/test-auth/audit').set('Cookie', ['poc_session=forged-token']);
    expect(res.status).toBe(401);
  });

  it('allows ADMIN on an audit:view endpoint', async () => {
    const userId = await createUserWithRoles('admin', ['ADMIN']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/audit')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(200);
  });

  it('rejects EMPLOYEE with 403 on an audit:view endpoint', async () => {
    const userId = await createUserWithRoles('employee', ['EMPLOYEE']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/audit')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(403);
  });

  it('rejects a user with no system roles (403, not 401)', async () => {
    const userId = await createUserWithRoles('nobody', []);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/audit')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(403);
  });

  it('ANDs required permissions: missing one key yields 403', async () => {
    // APPROVER has approval:decide but not user:invite.
    const userId = await createUserWithRoles('approver', ['APPROVER']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/both')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(403);
  });

  it('grants ADMIN business data access from admin status alone? No: 403', async () => {
    // Task-6 acceptance: admin identity must not imply business reads.
    const userId = await createUserWithRoles('admin', ['ADMIN']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/project-view')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(403);
  });

  it('unions permissions across multiple system roles (approver + manager)', async () => {
    const userId = await createUserWithRoles('dual', ['APPROVER', 'PROJECT_MANAGER']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/merged')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(200);
  });

  it('does not union when each role alone is insufficient', async () => {
    const userId = await createUserWithRoles('single', ['PROJECT_MANAGER']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/merged')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(403);
  });

  it('treats an endpoint without @Permissions as login-only', async () => {
    const userId = await createUserWithRoles('employee', ['EMPLOYEE']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .get('/test-auth/login-only')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(200);
  });

  it('enforces the CSRF header on mutating methods (regression)', async () => {
    const userId = await createUserWithRoles('admin', ['ADMIN']);
    const cookie = await sessionCookie(userId);

    const res = await http()
      .post('/test-auth/audit')
      .set('Cookie', [`poc_session=${cookie}`]);
    expect(res.status).toBe(401);
  });

  it('touches lastUsedAt when the session is validated (regression)', async () => {
    const userId = await createUserWithRoles('admin', ['ADMIN']);
    const cookie = await sessionCookie(userId);

    await http()
      .get('/test-auth/audit')
      .set('Cookie', [`poc_session=${cookie}`]);

    const session = await prisma.session.findFirstOrThrow({ where: { userId } });
    expect(session.lastUsedAt).not.toBeNull();
    expect(sessions).toBeDefined();
  });
});
