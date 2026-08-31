import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { randomToken, sha256Hex } from '../../src/crypto/token.util';
import { PrismaService } from '../../src/database/prisma.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { CustomersService } from '../../src/modules/customers/customers.service';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { ProjectAccessService } from '../../src/modules/project-access/project-access.service';
import { configureApp } from '../../src/startup-config';

const TABLES = [
  'audit_logs',
  'attachments',
  'order_items',
  'orders',
  'customer_contacts',
  'project_membership_roles',
  'project_memberships',
  'portfolio_memberships',
  'projects',
  'portfolios',
  'customers',
  'sessions',
  'user_system_roles',
  'role_permissions',
  'permissions',
  'system_roles',
  'users',
];

let app: INestApplication;
let prisma: PrismaService;
let attachmentRoot: string;

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

async function createUser(account: string) {
  return prisma.user.create({
    data: { account, name: account, workEmail: `${account}@example.test`, status: 'ACTIVE' },
  });
}

async function grantPermission(userId: string, permissionKey: 'project:manage') {
  const role = await prisma.systemRole.create({
    data: { key: 'PROJECT_MANAGER', name: '测试项目经理', requiresMfa: false },
  });
  const permission = await prisma.permission.upsert({
    where: { key: permissionKey },
    update: {},
    create: { key: permissionKey, description: permissionKey },
  });
  await prisma.rolePermission.create({
    data: { systemRoleId: role.id, permissionId: permission.id },
  });
  await prisma.userSystemRole.create({ data: { userId, systemRoleId: role.id } });
}

async function grantSystemRole(userId: string, key: 'ADMIN') {
  const role = await prisma.systemRole.create({
    data: { key, name: '测试系统管理员', requiresMfa: true },
  });
  await prisma.userSystemRole.create({ data: { userId, systemRoleId: role.id } });
}

async function cookie(userId: string): Promise<string> {
  const token = randomToken(32);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return `poc_session=${token}`;
}

async function addProjectMember(
  userId: string,
  projectId: string,
  role: 'PROJECT_MANAGER' | 'MEMBER',
) {
  await prisma.projectMembership.create({
    data: { userId, projectId, roles: { create: [{ role }] } },
  });
}

function mutate(http: request.Test) {
  return http.set('x-requested-with', 'XMLHttpRequest');
}

function parseBinary(
  response: Response,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => callback(error));
}

beforeAll(async () => {
  attachmentRoot = await mkdtemp(join(tmpdir(), 'poc-task7-http-'));
  process.env.ATTACHMENTS_ROOT = attachmentRoot;
  process.env.MFA_SECRET_KEY = '11'.repeat(32);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  prisma = moduleRef.get(PrismaService);
});

beforeEach(async () => truncateAll());

afterAll(async () => {
  await app.close();
  await rm(attachmentRoot, { recursive: true, force: true });
});

describe('task 7 AppModule HTTP contract on PostgreSQL', () => {
  it('scopes reads to membership and never grants ADMIN a business-data bypass', async () => {
    const manager = await createUser('manager-http');
    const member = await createUser('member-http');
    const admin = await createUser('admin-http');
    await grantSystemRole(admin.id, 'ADMIN');
    const project = await prisma.project.create({
      data: { number: 'HTTP-P1', name: 'HTTP 项目', status: 'ACTIVE' },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    await addProjectMember(member.id, project.id, 'MEMBER');

    const managerCookie = await cookie(manager.id);
    const memberCookie = await cookie(member.id);
    const adminCookie = await cookie(admin.id);

    await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', managerCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', memberCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', adminCookie)
      .expect(404);
    const adminList = await request(app.getHttpServer())
      .get('/api/v1/projects?page=1&pageSize=20')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(adminList.body.items).toEqual([]);
  });

  it('keeps active projects visible without exposing archived customer or portfolio relations', async () => {
    const member = await createUser('member-archived-relations');
    const customerByStatus = await prisma.customer.create({
      data: {
        number: 'HTTP-REL-C-STATUS',
        name: '状态归档客户',
        status: 'ARCHIVED',
        deletedAt: null,
      },
    });
    const customerByTimestamp = await prisma.customer.create({
      data: {
        number: 'HTTP-REL-C-TIME',
        name: '时间归档客户',
        status: 'ACTIVE',
        deletedAt: new Date('2026-08-23T00:00:00.000Z'),
      },
    });
    const portfolioByTimestamp = await prisma.portfolio.create({
      data: {
        name: '时间归档项目集',
        status: 'ACTIVE',
        deletedAt: new Date('2026-08-23T00:00:00.000Z'),
      },
    });
    const portfolioByStatus = await prisma.portfolio.create({
      data: {
        name: '状态归档项目集',
        status: 'ARCHIVED',
        deletedAt: null,
      },
    });
    const statusProject = await prisma.project.create({
      data: {
        number: 'HTTP-REL-P-STATUS',
        name: '状态归档关联项目',
        status: 'ACTIVE',
        customerId: customerByStatus.id,
        portfolioId: portfolioByTimestamp.id,
      },
    });
    const timestampProject = await prisma.project.create({
      data: {
        number: 'HTTP-REL-P-TIME',
        name: '时间归档关联项目',
        status: 'ACTIVE',
        customerId: customerByTimestamp.id,
        portfolioId: portfolioByStatus.id,
      },
    });
    await addProjectMember(member.id, statusProject.id, 'MEMBER');
    await addProjectMember(member.id, timestampProject.id, 'MEMBER');
    const memberCookie = await cookie(member.id);

    const list = await request(app.getHttpServer())
      .get('/api/v1/projects?page=1&pageSize=20')
      .set('Cookie', memberCookie)
      .expect(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: statusProject.id, customer: null, portfolio: null }),
        expect.objectContaining({ id: timestampProject.id, customer: null, portfolio: null }),
      ]),
    );

    for (const project of [statusProject, timestampProject]) {
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/projects/${project.id}`)
        .set('Cookie', memberCookie)
        .expect(200);
      expect(detail.body).toMatchObject({ id: project.id, customer: null, portfolio: null });
      expect(JSON.stringify(detail.body)).not.toContain('归档客户');
      expect(JSON.stringify(detail.body)).not.toContain('归档项目集');
    }
  });

  it('rejects unknown fields, invalid types, impossible dates, repeated query values, and non-DRAFT order creation', async () => {
    const manager = await createUser('manager-validation');
    await grantPermission(manager.id, 'project:manage');
    const project = await prisma.project.create({
      data: { number: 'HTTP-VALIDATION', name: '校验项目', status: 'ACTIVE' },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    const managerCookie = await cookie(manager.id);

    await mutate(
      request(app.getHttpServer()).post('/api/v1/projects').set('Cookie', managerCookie).send({
        number: 'HTTP-UNKNOWN',
        name: '未知字段',
        ownerId: manager.id,
      }),
    ).expect(400);
    await mutate(
      request(app.getHttpServer()).post('/api/v1/projects').set('Cookie', managerCookie).send({
        number: 'HTTP-BAD-DATE',
        name: '非法日期',
        startDate: '2026-02-30',
      }),
    ).expect(400);
    await mutate(
      request(app.getHttpServer())
        .patch(`/api/v1/projects/${project.id}`)
        .set('Cookie', managerCookie)
        .send({
          version: 1,
          completionPercent: 101,
        }),
    ).expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/projects?page=1&page=2')
      .set('Cookie', managerCookie)
      .expect(400);
    await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/projects/${project.id}/orders`)
        .set('Cookie', managerCookie)
        .send({
          number: 'HTTP-NON-DRAFT',
          title: '非法初始状态',
          status: 'ACTIVE',
        }),
    ).expect(400);
  });

  it('treats an archived project and all nested business resources as not found', async () => {
    const manager = await createUser('manager-archived');
    await grantPermission(manager.id, 'project:manage');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-ARCHIVED-C', name: '归档项目客户', status: 'ACTIVE' },
    });
    const project = await prisma.project.create({
      data: {
        number: 'HTTP-ARCHIVED-P',
        name: '待归档项目',
        status: 'ACTIVE',
        customerId: customer.id,
      },
    });
    const order = await prisma.order.create({
      data: { number: 'HTTP-ARCHIVED-O', title: '归档项目订单', projectId: project.id },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    const managerCookie = await cookie(manager.id);
    // Simulate historical or partially repaired data where the status was
    // archived but the soft-delete timestamp was not populated.
    await prisma.project.update({
      where: { id: project.id },
      data: { status: 'ARCHIVED', deletedAt: null },
    });

    await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', managerCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}/orders`)
      .set('Cookie', managerCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}/orders/${order.id}`)
      .set('Cookie', managerCookie)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.id}`)
      .set('Cookie', managerCookie)
      .expect(404);
  });

  it('enforces system permission plus project role, optimistic conflicts, and nested order scope', async () => {
    const manager = await createUser('manager-write');
    const member = await createUser('member-write');
    await grantPermission(manager.id, 'project:manage');
    const project = await prisma.project.create({
      data: { number: 'HTTP-P2', name: '可维护项目', status: 'ACTIVE' },
    });
    const otherProject = await prisma.project.create({
      data: { number: 'HTTP-P3', name: '另一项目', status: 'ACTIVE' },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    await addProjectMember(manager.id, otherProject.id, 'PROJECT_MANAGER');
    await addProjectMember(member.id, project.id, 'MEMBER');
    const managerCookie = await cookie(manager.id);
    const memberCookie = await cookie(member.id);

    await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/projects/${project.id}/orders`)
        .set('Cookie', memberCookie)
        .send({ number: 'NOPE', title: '越权' }),
    ).expect(403);
    const orderResponse = await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/projects/${project.id}/orders`)
        .set('Cookie', managerCookie)
        .send({ number: 'HTTP-O1', title: '真实订单' }),
    ).expect(201);
    const orderId = orderResponse.body.id as string;

    await request(app.getHttpServer())
      .get(`/api/v1/projects/${otherProject.id}/orders/${orderId}`)
      .set('Cookie', managerCookie)
      .expect(404);
    await mutate(
      request(app.getHttpServer())
        .patch(`/api/v1/projects/${project.id}`)
        .set('Cookie', managerCookie)
        .send({ name: '冲突更新', version: 999 }),
    ).expect(409);

    const item = await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/projects/${project.id}/orders/${orderId}/items`)
        .set('Cookie', managerCookie)
        .send({ version: orderResponse.body.version, name: '交付项', quantity: 2 }),
    ).expect(201);
    await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/projects/${project.id}/orders/${orderId}/items`)
        .set('Cookie', managerCookie)
        .send({ version: orderResponse.body.version, name: '过期写入', quantity: 1 }),
    ).expect(409);
    const orderAfterCreate = await request(app.getHttpServer())
      .get(`/api/v1/projects/${project.id}/orders/${orderId}`)
      .set('Cookie', managerCookie)
      .expect(200);
    await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/projects/${project.id}/orders/${orderId}/items/${item.body.id}/archive`)
        .set('Cookie', managerCookie)
        .send({ version: orderAfterCreate.body.version }),
    ).expect(201);
    const stored = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.body.id } });
    expect(stored.status).toBe('CANCELLED');
  });

  it.each([
    [
      'libreoffice-4.2.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['libreoffice-5.0.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    [
      'microsoft-word-12.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'microsoft-excel-12.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  ])(
    'uploads, downloads and archives a real OOXML fixture through HTTP: %s',
    async (filename, mimeType) => {
      const manager = await createUser(`manager-ooxml-${filename}`);
      await grantPermission(manager.id, 'project:manage');
      const customer = await prisma.customer.create({
        data: { number: `HTTP-${filename}`, name: `OOXML ${filename}`, status: 'ACTIVE' },
      });
      const project = await prisma.project.create({
        data: {
          number: `PROJECT-${filename}`,
          name: `OOXML ${filename}`,
          status: 'ACTIVE',
          customerId: customer.id,
        },
      });
      await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
      const managerCookie = await cookie(manager.id);
      const fixture = await readFile(join(process.cwd(), 'test/fixtures/ooxml', filename));

      const uploaded = await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/contract-attachments`)
        .set('Cookie', managerCookie)
        .set('x-requested-with', 'XMLHttpRequest')
        .attach('file', fixture, { filename, contentType: mimeType })
        .expect(201);
      const attachmentId = uploaded.body.id as string;
      const downloaded = await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/contract-attachments/${attachmentId}/download`)
        .set('Cookie', managerCookie)
        .buffer(true)
        .parse(parseBinary)
        .expect(200);
      expect(Buffer.from(downloaded.body as Uint8Array)).toEqual(fixture);

      await mutate(
        request(app.getHttpServer())
          .post(`/api/v1/customers/${customer.id}/contract-attachments/${attachmentId}/archive`)
          .set('Cookie', managerCookie),
      ).expect(201);
      const archived = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(archived.status).toBe('ARCHIVED');
      expect(archived.storageDeletedAt).toBeInstanceOf(Date);
    },
  );

  it('maintains contacts and contract attachments without exposing storage metadata', async () => {
    const manager = await createUser('manager-files');
    const member = await createUser('member-files');
    await grantPermission(manager.id, 'project:manage');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-C1', name: '合同客户', status: 'ACTIVE' },
    });
    const project = await prisma.project.create({
      data: { number: 'HTTP-P4', name: '合同项目', status: 'ACTIVE', customerId: customer.id },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    await addProjectMember(member.id, project.id, 'MEMBER');
    const managerCookie = await cookie(manager.id);
    const memberCookie = await cookie(member.id);

    const contact = await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/contacts`)
        .set('Cookie', managerCookie)
        .send({ version: 1, name: '联系人甲', workEmail: 'contact@example.test', isPrimary: true }),
    ).expect(201);
    expect(contact.body).toMatchObject({ customerId: customer.id, name: '联系人甲' });
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.id}/contacts`)
      .set('Cookie', memberCookie)
      .expect(403);

    const uploaded = await request(app.getHttpServer())
      .post(`/api/v1/customers/${customer.id}/contract-attachments`)
      .set('Cookie', managerCookie)
      .set('x-requested-with', 'XMLHttpRequest')
      .attach('file', Buffer.from('%PDF-1.7\ncontract'), {
        filename: 'contract.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(uploaded.body).not.toHaveProperty('storageKey');
    expect(uploaded.body).not.toHaveProperty('sha256');
    expect(uploaded.body).not.toHaveProperty('path');

    const attachmentId = uploaded.body.id as string;
    const downloaded = await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.id}/contract-attachments/${attachmentId}/download`)
      .set('Cookie', managerCookie)
      .expect(200);
    expect(downloaded.headers['content-type']).toContain('application/pdf');
    expect(downloaded.body).toEqual(Buffer.from('%PDF-1.7\ncontract'));

    await mutate(
      request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/contract-attachments/${attachmentId}/archive`)
        .set('Cookie', managerCookie),
    ).expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.id}/contract-attachments/${attachmentId}/download`)
      .set('Cookie', managerCookie)
      .expect(404);
    const archivedAttachment = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachmentId },
    });
    expect(archivedAttachment).toMatchObject({ status: 'ARCHIVED' });
    expect(archivedAttachment.deletedAt).toBeInstanceOf(Date);
    expect(archivedAttachment.storageDeletedAt).toBeInstanceOf(Date);
    await expect(
      prisma.auditLog.findMany({
        where: { actorId: manager.id, resourceId: attachmentId },
        select: { action: true, result: true, summary: true },
        orderBy: { createdAt: 'asc' },
      }),
    ).resolves.toEqual([
      {
        action: 'contract_attachment.upload',
        result: 'SUCCESS',
        summary: '合同附件操作成功',
      },
      {
        action: 'contract_attachment.download',
        result: 'SUCCESS',
        summary: '合同附件操作成功',
      },
      {
        action: 'contract_attachment.archive',
        result: 'SUCCESS',
        summary: '合同附件操作成功',
      },
      {
        action: 'contract_attachment.download',
        result: 'FAILURE',
        summary: '合同附件操作失败',
      },
    ]);
  });

  it('reconciles a durable published PENDING row with persisted file identity', async () => {
    const manager = await createUser('manager-pending-recovery');
    await grantPermission(manager.id, 'project:manage');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-PENDING-C', name: '待恢复附件客户', status: 'ACTIVE' },
    });
    const project = await prisma.project.create({
      data: {
        number: 'HTTP-PENDING-P',
        name: '待恢复附件项目',
        status: 'ACTIVE',
        customerId: customer.id,
      },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    const storageKey = 'customer-contract/aa/10000000-0000-4000-8000-000000000000.pdf';
    const finalPath = join(attachmentRoot, storageKey);
    await mkdir(join(attachmentRoot, 'customer-contract/aa'), { recursive: true });
    await chmod(join(attachmentRoot, 'customer-contract'), 0o700);
    await chmod(join(attachmentRoot, 'customer-contract/aa'), 0o700);
    await writeFile(finalPath, Buffer.from('%PDF-1.7\npublished'), { mode: 0o600 });
    const identity = await stat(finalPath);
    const pending = await prisma.attachment.create({
      data: {
        storageKey,
        originalName: 'published.pdf',
        mimeType: 'application/pdf',
        sizeBytes: identity.size,
        sha256: createHash('sha256').update('%PDF-1.7\npublished').digest('hex'),
        uploadedById: manager.id,
        resourceType: 'CUSTOMER_CONTRACT',
        resourceId: customer.id,
        customerId: customer.id,
        status: 'PENDING',
        storagePublishedAt: new Date(),
        storageDevice: BigInt(identity.dev),
        storageInode: BigInt(identity.ino),
      },
    });

    const service = app.get(AttachmentsService);
    await expect(service.onApplicationBootstrap()).resolves.toMatchObject({ failed: 0 });
    const recovered = await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(recovered).toMatchObject({ status: 'ACTIVE', storageCleanupAttempts: 0 });
    expect(recovered.storageCleanupLastError).toBeNull();
  });

  it('fails closed and persists retry metadata for a PENDING row with mismatched identity', async () => {
    const manager = await createUser('manager-pending-mismatch');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-PENDING-MISMATCH', name: '身份冲突附件客户', status: 'ACTIVE' },
    });
    const storageKey = 'customer-contract/bb/20000000-0000-4000-8000-000000000000.pdf';
    const finalPath = join(attachmentRoot, storageKey);
    const ownedPath = join(attachmentRoot, 'owned-pending.pdf');
    await mkdir(join(attachmentRoot, 'customer-contract/bb'), { recursive: true });
    await chmod(join(attachmentRoot, 'customer-contract'), 0o700);
    await chmod(join(attachmentRoot, 'customer-contract/bb'), 0o700);
    await writeFile(ownedPath, Buffer.from('%PDF-1.7\nowned'), { mode: 0o600 });
    const identity = await stat(ownedPath);
    const replacement = Buffer.from('%PDF-1.7\nreplacement');
    await writeFile(finalPath, replacement, { mode: 0o600 });
    const pending = await prisma.attachment.create({
      data: {
        storageKey,
        originalName: 'mismatch.pdf',
        mimeType: 'application/pdf',
        sizeBytes: replacement.length,
        sha256: createHash('sha256').update(replacement).digest('hex'),
        uploadedById: manager.id,
        resourceType: 'CUSTOMER_CONTRACT',
        resourceId: customer.id,
        customerId: customer.id,
        status: 'PENDING',
        storagePublishedAt: new Date(),
        storageDevice: BigInt(identity.dev),
        storageInode: BigInt(identity.ino),
      },
    });

    const service = app.get(AttachmentsService);
    await service.onApplicationBootstrap();
    const blocked = await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(blocked.status).toBe('PENDING');
    expect(blocked.storageCleanupAttempts).toBe(1);
    expect(blocked.storageCleanupLastError).toBe('INVALID_STORAGE_PATH');
    await expect(readFile(finalPath)).resolves.toEqual(replacement);
  });

  it('never activates an unmarked PENDING final even when its persisted identity matches', async () => {
    const manager = await createUser('manager-pending-unmarked');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-PENDING-UNMARKED', name: '无标记附件客户', status: 'ACTIVE' },
    });
    const storageKey = 'customer-contract/cc/30000000-0000-4000-8000-000000000000.pdf';
    const finalPath = join(attachmentRoot, storageKey);
    await mkdir(join(attachmentRoot, 'customer-contract/cc'), { recursive: true });
    await chmod(join(attachmentRoot, 'customer-contract'), 0o700);
    await chmod(join(attachmentRoot, 'customer-contract/cc'), 0o700);
    await writeFile(finalPath, Buffer.from('%PDF-1.7\nunmarked'), { mode: 0o600 });
    const identity = await stat(finalPath);
    const pending = await prisma.attachment.create({
      data: {
        storageKey,
        originalName: 'unmarked.pdf',
        mimeType: 'application/pdf',
        sizeBytes: identity.size,
        sha256: createHash('sha256').update('%PDF-1.7\nunmarked').digest('hex'),
        uploadedById: manager.id,
        resourceType: 'CUSTOMER_CONTRACT',
        resourceId: customer.id,
        customerId: customer.id,
        status: 'PENDING',
        storagePublishedAt: null,
        storageDevice: BigInt(identity.dev),
        storageInode: BigInt(identity.ino),
      },
    });

    await app.get(AttachmentsService).onApplicationBootstrap();

    const blocked = await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(blocked.status).toBe('PENDING');
    expect(blocked.storagePublishedAt).toBeNull();
    expect(blocked.storageCleanupAttempts).toBe(1);
    await expect(readFile(finalPath)).resolves.toEqual(Buffer.from('%PDF-1.7\nunmarked'));
  });

  it('preserves an unmarked temp-only PENDING file and its retry evidence', async () => {
    const manager = await createUser('manager-pending-unmarked-temp');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-PENDING-UNMARKED-TEMP', name: '无标记临时附件客户', status: 'ACTIVE' },
    });
    const id = '35000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/ce/${id}.pdf`;
    const finalPath = join(attachmentRoot, storageKey);
    const tempPath = join(attachmentRoot, 'customer-contract/ce', `.${id}.pdf.pending`);
    const content = Buffer.from('%PDF-1.7\nunmarked-temp-only');
    await mkdir(join(attachmentRoot, 'customer-contract/ce'), { recursive: true });
    await chmod(join(attachmentRoot, 'customer-contract'), 0o700);
    await chmod(join(attachmentRoot, 'customer-contract/ce'), 0o700);
    await writeFile(tempPath, content, { mode: 0o600 });
    const identity = await stat(tempPath);
    const pending = await prisma.attachment.create({
      data: {
        storageKey,
        originalName: 'unmarked-temp-only.pdf',
        mimeType: 'application/pdf',
        sizeBytes: identity.size,
        sha256: createHash('sha256').update(content).digest('hex'),
        uploadedById: manager.id,
        resourceType: 'CUSTOMER_CONTRACT',
        resourceId: customer.id,
        customerId: customer.id,
        status: 'PENDING',
        storagePublishedAt: null,
        storageDevice: BigInt(identity.dev),
        storageInode: BigInt(identity.ino),
      },
    });

    await app.get(AttachmentsService).onApplicationBootstrap();

    const blocked = await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(blocked.status).toBe('PENDING');
    expect(blocked.storagePublishedAt).toBeNull();
    expect(blocked.storageCleanupAttempts).toBe(1);
    expect(blocked.storageCleanupLastError).toBe('PENDING_PUBLICATION_MARKER_MISSING');
    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(tempPath)).resolves.toEqual(content);
  });

  it('does not republish or activate a marked temp-only PENDING file', async () => {
    const manager = await createUser('manager-pending-temp-only');
    const customer = await prisma.customer.create({
      data: { number: 'HTTP-PENDING-TEMP', name: '仅临时附件客户', status: 'ACTIVE' },
    });
    const id = '40000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/dd/${id}.pdf`;
    const finalPath = join(attachmentRoot, storageKey);
    const tempPath = join(attachmentRoot, 'customer-contract/dd', `.${id}.pdf.pending`);
    await mkdir(join(attachmentRoot, 'customer-contract/dd'), { recursive: true });
    await chmod(join(attachmentRoot, 'customer-contract'), 0o700);
    await chmod(join(attachmentRoot, 'customer-contract/dd'), 0o700);
    await writeFile(tempPath, Buffer.from('%PDF-1.7\ntemp-only'), { mode: 0o600 });
    const identity = await stat(tempPath);
    const pending = await prisma.attachment.create({
      data: {
        storageKey,
        originalName: 'temp-only.pdf',
        mimeType: 'application/pdf',
        sizeBytes: identity.size,
        sha256: createHash('sha256').update('%PDF-1.7\ntemp-only').digest('hex'),
        uploadedById: manager.id,
        resourceType: 'CUSTOMER_CONTRACT',
        resourceId: customer.id,
        customerId: customer.id,
        status: 'PENDING',
        storagePublishedAt: new Date(),
        storageDevice: BigInt(identity.dev),
        storageInode: BigInt(identity.ino),
      },
    });

    await app.get(AttachmentsService).onApplicationBootstrap();

    const blocked = await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(blocked.status).toBe('PENDING');
    expect(blocked.storageCleanupAttempts).toBe(1);
    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(tempPath)).resolves.toEqual(Buffer.from('%PDF-1.7\ntemp-only'));
  });

  it('withholds sensitive customer fields when manager membership is revoked between queries', async () => {
    const manager = await createUser('manager-sensitive-race');
    await grantPermission(manager.id, 'project:manage');
    const customer = await prisma.customer.create({
      data: {
        number: 'HTTP-SENSITIVE-RACE',
        name: '敏感竞态客户',
        status: 'ACTIVE',
        notes: '机密',
      },
    });
    const project = await prisma.project.create({
      data: {
        number: 'HTTP-SENSITIVE-P',
        name: '敏感竞态项目',
        status: 'ACTIVE',
        customerId: customer.id,
      },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    const service = app.get(CustomersService);
    const originalFindMany = prisma.customer.findMany.bind(prisma.customer);
    let findManyCalls = 0;
    const baseQuerySpy = vi.spyOn(prisma.customer, 'findMany');
    baseQuerySpy.mockImplementation((async (args: Parameters<typeof originalFindMany>[0]) => {
      findManyCalls += 1;
      const result = await originalFindMany(args);
      if (findManyCalls === 1) {
        const membership = await prisma.projectMembership.findUniqueOrThrow({
          where: { userId_projectId: { userId: manager.id, projectId: project.id } },
          select: { id: true },
        });
        await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
        await prisma.projectMembership.delete({ where: { id: membership.id } });
      }
      return result;
    }) as never);

    try {
      const result = await service.list(manager.id, { page: 1, pageSize: 20 });
      expect(findManyCalls).toBe(2);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty('notes');
      expect(result.items[0]).not.toHaveProperty('contacts');
    } finally {
      baseQuerySpy.mockRestore();
    }
  });

  it('fails OrderItem reads and writes when membership is revoked after the precheck', async () => {
    const manager = await createUser('manager-order-item-race');
    await grantPermission(manager.id, 'project:manage');
    const project = await prisma.project.create({
      data: { number: 'HTTP-ITEM-RACE-P', name: '订单项竞态项目', status: 'ACTIVE' },
    });
    await addProjectMember(manager.id, project.id, 'PROJECT_MANAGER');
    const order = await prisma.order.create({
      data: { number: 'HTTP-ITEM-RACE-O', title: '订单项竞态订单', projectId: project.id },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, name: '竞态项', quantity: 1 } });
    const service = app.get(OrdersService);
    const access = app.get(ProjectAccessService);
    const originalAssert = access.assertProjectRole.bind(access);
    const roleSpy = vi
      .spyOn(access, 'assertProjectRole')
      .mockImplementationOnce(async (...args) => {
        const result = await originalAssert(...args);
        const membership = await prisma.projectMembership.findUniqueOrThrow({
          where: { userId_projectId: { userId: manager.id, projectId: project.id } },
          select: { id: true },
        });
        await prisma.projectMembershipRole.deleteMany({ where: { membershipId: membership.id } });
        await prisma.projectMembership.delete({ where: { id: membership.id } });
        return result;
      });

    try {
      await expect(
        service.createItem(manager.id, project.id, order.id, {
          version: order.version,
          name: '不得创建',
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(Error);
      await expect(service.listItems(manager.id, project.id, order.id)).rejects.toBeInstanceOf(
        Error,
      );
      await expect(prisma.orderItem.count({ where: { orderId: order.id } })).resolves.toBe(1);
    } finally {
      roleSpy.mockRestore();
    }
  });
});
