import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { MfaCipherService } from '../crypto/mfa-cipher.service';
import { PrismaService } from '../database/prisma.service';
import { installWindowsAclAllowlist } from '../testing/windows-acl-allowlist';
import { WorkLogsController } from './work-logs/work-logs.controller';
import { WorkLogsService } from './work-logs/work-logs.service';

let attachmentsRoot = '';
let previousRoot: string | undefined;

beforeEach(async () => {
  previousRoot = process.env.ATTACHMENTS_ROOT;
  attachmentsRoot = await mkdtemp(join(tmpdir(), 'poc-task8-runtime-'));
  process.env.ATTACHMENTS_ROOT = attachmentsRoot;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ATTACHMENTS_ROOT;
  else process.env.ATTACHMENTS_ROOT = previousRoot;
  await rm(attachmentsRoot, { recursive: true, force: true });
});

beforeAll(installWindowsAclAllowlist);

/**
 * 任务 8 的 HTTP 边界（审查 review-3 指出：控制器层没有自动化证据）。
 *
 * - 两个路由必须注册在鉴权之后：未登录一律 401（既证明路由存在，也证明守卫生效）。
 * - 控制器必须用**路径参数**的 projectId 覆盖 body 里的同名字段，防止客户端把
 *   日志写进另一个项目。
 */
describe('task 8 work-log HTTP surface', () => {
  it('registers create and submit routes behind authentication', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ attachment: { findMany: vi.fn().mockResolvedValue([]) } })
      .overrideProvider(MfaCipherService)
      .useValue({ encrypt: vi.fn(), decrypt: vi.fn() })
      .compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    try {
      const create = await request(app.getHttpServer())
        .post('/api/v1/projects/project-1/work-logs')
        .send({ workDate: '2026-11-06', hours: 1, completion: 'x' });
      expect(create.status).toBe(401);

      const submit = await request(app.getHttpServer())
        .post('/api/v1/work-logs/work-log-1/submit')
        .send({ approverId: 'approver-1' });
      expect(submit.status).toBe(401);

      const newVersion = await request(app.getHttpServer())
        .post('/api/v1/work-logs/work-log-1/versions')
        .send({ workDate: '2026-11-07', hours: 1, completion: 'x' });
      expect(newVersion.status).toBe(401);

      const editDraft = await request(app.getHttpServer())
        .patch('/api/v1/work-logs/work-log-1')
        .send({ workDate: '2026-11-07', hours: 1, completion: 'x' });
      expect(editDraft.status).toBe(401);

      const visibility = await request(app.getHttpServer())
        .patch('/api/v1/work-logs/work-log-1/visibility')
        .send({ visibility: 'PROJECT_VISIBLE', version: 1 });
      expect(visibility.status).toBe(401);

      const metadata = await request(app.getHttpServer()).get(
        '/api/v1/projects/project-1/work-logs/visibility',
      );
      expect(metadata.status).toBe(401);

      const myLogs = await request(app.getHttpServer()).get('/api/v1/my/work-logs');
      expect(myLogs.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('forces the path projectId and ignores a conflicting body projectId', async () => {
    const createDraft = vi.fn().mockResolvedValue({ id: 'wl-1' });
    const controller = new WorkLogsController({ createDraft } as unknown as WorkLogsService);

    await controller.create({ user: { id: 'author-1' } } as never, 'project-from-path', {
      projectId: 'project-from-body',
      workDate: '2026-11-06',
      hours: 1,
      completion: 'x',
    });

    expect(createDraft).toHaveBeenCalledWith(
      'author-1',
      expect.objectContaining({ projectId: 'project-from-path' }),
    );
  });
});
