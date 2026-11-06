import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../authorization/permission.constants';
import { WorkLogsService } from './work-logs.service';

/**
 * D-A / D-B（主计划 §4.2）：
 *  - 只有"项目作用域内的 PROJECT_MANAGER"或持有 worklog:manage 能力者可以设置可见性（OR，2026-11-06 用户决定）。
 *  - 为"有可见性写权但无正文读权"的角色提供最小元数据入口：只返回 id/visibility/version，
 *    不返回正文/历史/附件，不按私有字段搜索或排序，不放宽既有读取权限。
 */
function createPrismaMock() {
  const log = {
    id: 'wl-1',
    authorId: 'author-1',
    projectId: 'project-1',
    status: 'DRAFT',
    visibility: 'PRIVATE',
    version: 3,
  };
  const prisma = {
    workLog: {
      findFirst: vi.fn().mockResolvedValue(log),
      findMany: vi.fn().mockResolvedValue([
        { id: 'wl-1', visibility: 'PRIVATE', version: 3 },
        { id: 'wl-2', visibility: 'PROJECT_VISIBLE', version: 1 },
      ]),
      count: vi.fn().mockResolvedValue(2),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return prisma;
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  options?: {
    roles?: string[];
    permissions?: string[];
  },
) {
  const projectAccess = {
    assertProjectAccess: vi
      .fn()
      .mockResolvedValue({ roles: options?.roles ?? ['PROJECT_MANAGER'] }),
  };
  const roles = {
    listUserPermissions: vi.fn().mockResolvedValue(options?.permissions ?? []),
  };
  const service = new WorkLogsService(prisma as never, projectAccess as never, roles as never);
  return { service, projectAccess, roles };
}

describe('WorkLogsService.setVisibility', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it('lets a project manager set visibility with the optimistic version token', async () => {
    const { service } = createService(prisma);

    await service.setVisibility('pm-1', 'wl-1', { visibility: 'PROJECT_VISIBLE', version: 3 });

    expect(prisma.workLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'wl-1',
        projectId: 'project-1',
        deletedAt: null,
        version: 3,
      },
      data: { visibility: 'PROJECT_VISIBLE', version: { increment: 1 } },
    });
  });

  it('lets a worklog:manage holder set visibility without the project manager role', async () => {
    prisma = createPrismaMock();
    const { service } = createService(prisma, {
      roles: ['MEMBER'],
      permissions: [PERMISSIONS.WORKLOG_MANAGE],
    });

    await service.setVisibility('mgr-1', 'wl-1', { visibility: 'PRIVATE', version: 3 });

    expect(prisma.workLog.updateMany).toHaveBeenCalledOnce();
  });

  it('requires project membership even for a worklog:manage holder', async () => {
    const prisma = createPrismaMock();
    const service = new WorkLogsService(
      prisma as never,
      {
        assertProjectAccess: vi.fn().mockRejectedValue(new NotFoundException('项目不存在')),
      } as never,
      {
        listUserPermissions: vi.fn().mockResolvedValue([PERMISSIONS.WORKLOG_MANAGE]),
      } as never,
    );

    await expect(
      service.setVisibility('outsider-1', 'wl-1', { visibility: 'PROJECT_VISIBLE', version: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.workLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a plain member who has neither the role nor the capability', async () => {
    prisma = createPrismaMock();
    const { service } = createService(prisma, { roles: ['MEMBER'], permissions: [] });

    await expect(
      service.setVisibility('member-1', 'wl-1', { visibility: 'PROJECT_VISIBLE', version: 3 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workLog.updateMany).not.toHaveBeenCalled();
  });

  it('returns 409 when the caller version is stale', async () => {
    prisma.workLog.updateMany.mockResolvedValue({ count: 0 });
    const { service } = createService(prisma);

    await expect(
      service.setVisibility('pm-1', 'wl-1', { visibility: 'PROJECT_VISIBLE', version: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an unknown visibility or missing version before writing', async () => {
    const { service } = createService(prisma);

    await expect(
      service.setVisibility('pm-1', 'wl-1', { visibility: 'PUBLIC', version: 3 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setVisibility('pm-1', 'wl-1', { visibility: 'PRIVATE', version: 0 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workLog.updateMany).not.toHaveBeenCalled();
  });
});

describe('WorkLogsService.listVisibilityMetadata', () => {
  it('returns only id/visibility/version plus paging stats', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    const result = await service.listVisibilityMetadata('pm-1', 'project-1', {
      page: 1,
      pageSize: 20,
    });

    expect(result).toEqual({
      items: [
        { id: 'wl-1', visibility: 'PRIVATE', version: 3 },
        { id: 'wl-2', visibility: 'PROJECT_VISIBLE', version: 1 },
      ],
      page: 1,
      pageSize: 20,
      total: 2,
    });
    // 元数据入口不得读取正文/历史/附件：查询字段与过滤条件必须固定。
    expect(prisma.workLog.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', deletedAt: null },
      select: { id: true, visibility: true, version: true },
      orderBy: { id: 'asc' },
      skip: 0,
      take: 20,
    });
  });

  it('rejects callers without visibility rights', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma, { roles: ['MEMBER'], permissions: [] });

    await expect(
      service.listVisibilityMetadata('member-1', 'project-1', { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workLog.findMany).not.toHaveBeenCalled();
  });

  it('normalizes non-integer paging input instead of failing', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    await service.listVisibilityMetadata('pm-1', 'project-1', {
      page: Number.POSITIVE_INFINITY,
      pageSize: Number.NaN,
    } as never);

    expect(prisma.workLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it('clamps the page size so the endpoint cannot be used as a bulk dump', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);

    await service.listVisibilityMetadata('pm-1', 'project-1', { page: 1, pageSize: 5000 });

    expect(prisma.workLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});
