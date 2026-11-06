import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import {
  chown,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';

import { AttachmentsService } from './attachments.service';
import { installWindowsAclAllowlist } from '../../testing/windows-acl-allowlist';

const roots: string[] = [];
const pdf = Buffer.from('%PDF-1.7\ncontent');

// 本机受限令牌/CI 沙箱：临时目录的 ACL 含非运行账号主体（例如沙箱组与受限 SID）。
// 这里只把"该临时目录上已存在的主体"SIDs 显式加入白名单，并且**仅限测试进程**。
// 生产默认仍是严格白名单（空扩展名单），由 storage-platform.spec.ts 的纯函数用例固定。
beforeAll(installWindowsAclAllowlist);

const windowsStorage = process.platform === 'win32';

/**
 * 受限令牌（CI 沙箱 / 加固主机）可能禁止创建符号链接与联接点。
 * 用同步探测在收集阶段判定，无法创建时**显式跳过**依赖符号链接的用例，
 * 并在跳过原因里说明这些用例仍由 ubuntu-latest CI（生产基线）覆盖。
 */
function detectSymlinkSupport(): boolean {
  const probeRoot = join(process.cwd(), 'node_modules', '.symlink-probe');
  const target = join(probeRoot, 'target');
  const link = join(probeRoot, 'link');
  // 目录不可写属于环境故障，必须让测试红：不能把它伪装成"不支持符号链接"而跳过安全用例。
  mkdirSync(target, { recursive: true });
  try {
    rmSync(link, { force: true, recursive: true });
  } catch {
    /* 首次运行没有残留 */
  }
  try {
    symlinkSync(target, link, 'dir');
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    // 只有明确的权限/不支持类错误才降级为"跳过"；其它错误继续抛。
    if (!['EPERM', 'EACCES', 'UNKNOWN', 'EINVAL'].includes(code)) throw error;
    return false;
  } finally {
    try {
      rmSync(probeRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
}

// 受限令牌/加固主机无法创建符号链接时，下列用例会被跳过（理由见上方注释），
// 它们仍由 ubuntu-latest CI（生产基线）执行。
const SYMLINK_SUPPORTED = detectSymlinkSupport();
const runTool = promisify(execFile);

/**
 * 把一个目录/文件标记为"非私有"。
 * POSIX 用 chmod 模式位；Windows 没有模式位，改为授予 Everyone 访问权，
 * 由存储层 ACL 校验拒绝。
 */
async function openStorageWide(
  target: string,
  mode: number,
  kind: 'dir' | 'file' = 'dir',
): Promise<void> {
  if (!windowsStorage) {
    await chmod(target, mode);
    return;
  }
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  await runTool(icacls, [target, '/grant', kind === 'dir' ? '*S-1-1-0:(OI)(CI)F' : '*S-1-1-0:(R)']);
}

type ZipEntry = {
  name: string;
  localName?: string;
  data?: Buffer;
  method?: 0 | 8 | number;
  localMethod?: number;
  flags?: number;
  localFlags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  localCrc?: number;
  localCompressedSize?: number;
  localUncompressedSize?: number;
  localOffset?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  externalAttributes?: number;
  descriptor?: 'signed' | 'unsigned';
  descriptorCrc?: number;
  descriptorCompressedSize?: number;
  descriptorUncompressedSize?: number;
};

type ZipOptions = {
  comment?: Buffer;
  disk?: number;
  centralDisk?: number;
  entriesOnDisk?: number;
  totalEntries?: number;
  centralSize?: number;
  centralOffset?: number;
};

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipEntry[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let localLength = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = entry.flags ?? 0x0800;
    const localFlags = entry.localFlags ?? flags;
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt32LE(entry.localCrc ?? crc32(data), 14);
    local.writeUInt32LE(entry.localCompressedSize ?? compressedSize, 18);
    local.writeUInt32LE(entry.localUncompressedSize ?? uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    offsets.push(localLength);
    const descriptor = entry.descriptor
      ? (() => {
          const value = Buffer.alloc(entry.descriptor === 'signed' ? 16 : 12);
          let cursor = 0;
          if (entry.descriptor === 'signed') {
            value.writeUInt32LE(0x08074b50, 0);
            cursor = 4;
          }
          value.writeUInt32LE(entry.descriptorCrc ?? crc32(data), cursor);
          value.writeUInt32LE(entry.descriptorCompressedSize ?? compressedSize, cursor + 4);
          value.writeUInt32LE(entry.descriptorUncompressedSize ?? uncompressedSize, cursor + 8);
          return value;
        })()
      : Buffer.alloc(0);
    const localRecord = Buffer.concat([local, localName, localExtra, compressed, descriptor]);
    locals.push(localRecord);
    localLength += localRecord.length;

    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(compressedSize, 20);
    record.writeUInt32LE(uncompressedSize, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
    record.writeUInt32LE(entry.localOffset ?? offsets.at(-1)!, 42);
    central.push(Buffer.concat([record, name, centralExtra]));
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(central);
  const comment = options.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.disk ?? 0, 4);
  eocd.writeUInt16LE(options.centralDisk ?? 0, 6);
  eocd.writeUInt16LE(options.entriesOnDisk ?? entries.length, 8);
  eocd.writeUInt16LE(options.totalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(options.centralSize ?? centralBytes.length, 12);
  eocd.writeUInt32LE(options.centralOffset ?? localBytes.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localBytes, centralBytes, eocd, comment]);
}

function localHeadersOnly(names: string[]): Buffer {
  return Buffer.concat(
    names.map((name) => {
      const encoded = Buffer.from(name);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(encoded.length, 26);
      return Buffer.concat([header, encoded]);
    }),
  );
}

function tamperFirstStoredEntryData(archive: Buffer): Buffer {
  const value = Buffer.from(archive);
  const dataOffset = 30 + value.readUInt16LE(26) + value.readUInt16LE(28);
  value[dataOffset] = value[dataOffset]! ^ 0xff;
  return value;
}

function insertGapBeforeCentralDirectory(archive: Buffer, gap = Buffer.from('hidden')): Buffer {
  const eocdOffset = archive.length - 22;
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  const eocd = Buffer.from(archive.subarray(eocdOffset));
  eocd.writeUInt32LE(centralOffset + gap.length, 16);
  return Buffer.concat([
    archive.subarray(0, centralOffset),
    gap,
    archive.subarray(centralOffset, eocdOffset),
    eocd,
  ]);
}

function ambiguousDoubleEocdArchive(entries: ZipEntry[]): Buffer {
  const base = zip(entries);
  const firstEocdOffset = base.length - 22;
  const firstCentralOffset = base.readUInt32LE(firstEocdOffset + 16);
  const localBytes = base.subarray(0, firstCentralOffset);
  const centralBytes = base.subarray(firstCentralOffset, firstEocdOffset);
  const firstEocd = Buffer.from(base.subarray(firstEocdOffset));
  const secondEocd = Buffer.from(firstEocd);
  const secondCentralOffset = localBytes.length + centralBytes.length + firstEocd.length;
  secondEocd.writeUInt32LE(secondCentralOffset, 16);
  firstEocd.writeUInt16LE(centralBytes.length + secondEocd.length, 20);
  return Buffer.concat([localBytes, centralBytes, firstEocd, centralBytes, secondEocd]);
}

const docxEntries = [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<document/>') },
];
const xlsxEntries = [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
];

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'poc-attachments-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function successfulUploadPrisma() {
  let stored: Record<string, unknown> | null = null;
  const attachment = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stored = { id: 'a1', ...data, createdAt: new Date() };
      return { id: 'a1' };
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: vi.fn(async () => ({
      id: stored?.id,
      originalName: stored?.originalName,
      mimeType: stored?.mimeType,
      sizeBytes: stored?.sizeBytes,
      status: 'ACTIVE',
      createdAt: stored?.createdAt,
    })),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  return { attachment };
}

describe('AttachmentsService CUSTOMER_CONTRACT', () => {
  it('carries current customer-manager authorization into the final attachment list query', async () => {
    const prisma = { attachment: { findMany: vi.fn().mockResolvedValue([]) } };
    const customers = { assertCustomerManager: vi.fn().mockResolvedValue(undefined) };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(service.list('u1', 'c1')).resolves.toEqual([]);
    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 'c1',
          customer: {
            is: expect.objectContaining({
              id: 'c1',
              status: { not: 'ARCHIVED' },
              deletedAt: null,
              projects: {
                some: expect.objectContaining({
                  memberships: {
                    some: expect.objectContaining({
                      userId: 'u1',
                      roles: { some: { role: 'PROJECT_MANAGER' } },
                    }),
                  },
                }),
              },
            }),
          },
        }),
      }),
    );
  });

  it('carries current customer-manager authorization into final download and archive writes', async () => {
    const prisma = {
      attachment: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const customers = { assertCustomerManager: vi.fn().mockResolvedValue(undefined) };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(service.download('u1', 'c1', 'a1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.attachment.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 'c1',
          customer: { is: expect.objectContaining({ id: 'c1', projects: expect.any(Object) }) },
        }),
      }),
    );

    await expect(service.archive('u1', 'c1', 'a1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.attachment.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 'c1',
          customer: { is: expect.objectContaining({ id: 'c1', projects: expect.any(Object) }) },
        }),
      }),
    );
  });

  it('rejects upload when manager authorization vanishes before the final attachment create', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('relation vanished'), { code: 'P2025' }));
    const prisma = { attachment: { create } };
    const customers = { assertCustomerManager: vi.fn().mockResolvedValue(undefined) };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        uploadedBy: { connect: { id: 'u1' } },
        customer: {
          connect: expect.objectContaining({
            id: 'c1',
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            projects: expect.any(Object),
          }),
        },
      }),
      select: { id: true },
    });
  });

  it('rechecks current uploader authorization in the final activation predicate', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma = {
      attachment: {
        create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
        updateMany,
        deleteMany: vi.fn(),
      },
    };
    const customers = {
      assertCustomerManager: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new ForbiddenException()),
    };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(updateMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'pending-1',
          uploadedById: 'u1',
          customerId: 'c1',
          customer: { is: expect.objectContaining({ id: 'c1', projects: expect.any(Object) }) },
        }),
      }),
    );
    expect(customers.assertCustomerManager).toHaveBeenCalledTimes(2);
  });

  it('rechecks the persisted uploader authorization before startup recovery activates a pending row', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/aa000000-0000-4000-8000-000000000000.pdf';
    const finalPath = join(storageRoot, storageKey);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, pdf, { mode: 0o600 });
    const identity = await stat(finalPath);
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              uploadedById: 'u1',
              customerId: 'c1',
              storageKey,
              storagePublishedAt: new Date(),
              storageDevice: BigInt(identity.dev),
              storageInode: BigInt(identity.ino),
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        findUniqueOrThrow: vi.fn(),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 0 });

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'pending-1',
          uploadedById: 'u1',
          customerId: 'c1',
          customer: { is: expect.objectContaining({ id: 'c1', projects: expect.any(Object) }) },
        }),
      }),
    );
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE' }),
        where: expect.not.objectContaining({ customer: expect.any(Object) }),
      }),
    );
    expect(prisma.attachment.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects extension, declared MIME and magic-byte mismatches', async () => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.png',
        mimetype: 'image/png',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts real minimal DOCX and XLSX packages with EOCD and central directories', async () => {
    const prisma = successfulUploadPrisma();
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const docx = zip(docxEntries, { comment: Buffer.from('valid comment') });
    const xlsx = zip(xlsxEntries.map((entry) => ({ ...entry, method: 8 })));
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'a.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: docx.length,
        buffer: docx,
      }),
    ).resolves.toMatchObject({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'a.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: xlsx.length,
        buffer: xlsx,
      }),
    ).resolves.toMatchObject({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it.each([
    [
      'libreoffice-4.2.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'bdff4457ccfbe7482f8230e2e1085e8becdda5bc869237923a4e70977d3b6678',
    ],
    [
      'libreoffice-5.0.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '8800024c3f42ecc1c4171d6c34e35fced0a3c82f10ad5939f01ba85579979871',
    ],
    [
      'microsoft-word-12.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '8ab0f0afddd11ab43bd2dcfe4e5b51f8a4dfcc948fe3f327b338bcc2c3733bee',
    ],
    [
      'microsoft-excel-12.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '47e9e8dea87494d17dbacce9aa3a9ec31cb2b26b288de05ca95c0a4622ca7f80',
    ],
  ])(
    'accepts a public real-office OOXML fixture with a pinned hash: %s',
    async (filename, mimetype, expectedSha256) => {
      const fixture = await readFile(join(process.cwd(), 'test/fixtures/ooxml', filename));
      expect(createHash('sha256').update(fixture).digest('hex')).toBe(expectedSha256);
      const prisma = successfulUploadPrisma();
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn() } as never,
        await root(),
      );

      await expect(
        service.upload('u1', 'c1', {
          originalname: filename,
          mimetype,
          size: fixture.length,
          buffer: fixture,
        }),
      ).resolves.toMatchObject({ originalName: filename, mimeType: mimetype });
    },
  );

  it('rejects local-header-only OOXML impostors without EOCD and a central directory', async () => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const fake = localHeadersOnly(['[Content_Types].xml', 'word/document.xml']);
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'fake.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: fake.length,
        buffer: fake,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an entry whose bytes no longer match its declared CRC', async () => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = tamperFirstStoredEntryData(zip(docxEntries));
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects bytes outside complete local-entry and central-directory coverage', async () => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = insertGapBeforeCentralDirectory(zip(docxEntries));
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects archives with multiple structurally valid EOCD interpretations', async () => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = ambiguousDoubleEocdArchive(docxEntries);
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'central/local names differ',
      zip([{ ...docxEntries[0]!, localName: 'different.xml' }, docxEntries[1]!]),
    ],
    [
      'central local-header offset is wrong',
      zip([{ ...docxEntries[0]!, localOffset: 1 }, docxEntries[1]!]),
    ],
    ['central/local flags differ', zip([{ ...docxEntries[0]!, localFlags: 0 }, docxEntries[1]!])],
    [
      'central/local compression methods differ',
      zip([{ ...docxEntries[0]!, localMethod: 8 }, docxEntries[1]!]),
    ],
  ])('rejects OOXML when %s', async (_reason, archive) => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'MS Office compression-option flags 0x0006 with stored entries',
      zip(docxEntries.map((entry) => ({ ...entry, flags: 0x0006 }))),
    ],
    [
      'MS Office compression-option flags 0x0006 with deflated entries',
      zip(docxEntries.map((entry) => ({ ...entry, method: 8, flags: 0x0006 }))),
    ],
    [
      'UTF-8 names plus compression-option flags 0x0806',
      zip(docxEntries.map((entry) => ({ ...entry, method: 8, flags: 0x0806 }))),
    ],
  ])('accepts real-world Office files carrying %s', async (_reason, archive) => {
    const prisma = successfulUploadPrisma();
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'office.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).resolves.toMatchObject({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('accepts a bounded unsigned data descriptor when all central-directory values match', async () => {
    const prisma = successfulUploadPrisma();
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = zip([
      {
        ...docxEntries[0]!,
        flags: 0x0808,
        localCrc: 0,
        localCompressedSize: 0,
        localUncompressedSize: 0,
        descriptor: 'unsigned',
      },
      docxEntries[1]!,
    ]);

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'unsigned.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).resolves.toMatchObject({ originalName: 'unsigned.docx' });
  });

  it.each([
    ['encrypted entries', zip([{ ...docxEntries[0]!, flags: 0x0801 }, docxEntries[1]!])],
    [
      'a signed descriptor with a mismatched CRC',
      zip([
        {
          ...docxEntries[0]!,
          flags: 0x0808,
          localCrc: 0,
          localCompressedSize: 0,
          localUncompressedSize: 0,
          descriptor: 'signed',
          descriptorCrc: 0,
        },
        docxEntries[1]!,
      ]),
    ],
    [
      'a signed descriptor with a mismatched compressed size',
      zip([
        {
          ...docxEntries[0]!,
          flags: 0x0808,
          localCrc: 0,
          localCompressedSize: 0,
          localUncompressedSize: 0,
          descriptor: 'signed',
          descriptorCompressedSize: 99,
        },
        docxEntries[1]!,
      ]),
    ],
    [
      'a signed descriptor with a mismatched expanded size',
      zip([
        {
          ...docxEntries[0]!,
          flags: 0x0808,
          localCrc: 0,
          localCompressedSize: 0,
          localUncompressedSize: 0,
          descriptor: 'signed',
          descriptorUncompressedSize: 99,
        },
        docxEntries[1]!,
      ]),
    ],
    ['strongly encrypted entries', zip([{ ...docxEntries[0]!, flags: 0x0840 }, docxEntries[1]!])],
    ['reserved flag bits', zip([{ ...docxEntries[0]!, flags: 0x0810 }, docxEntries[1]!])],
    [
      'ZIP64 entry count sentinel',
      zip(docxEntries, { entriesOnDisk: 0xffff, totalEntries: 0xffff }),
    ],
    ['ZIP64 size sentinel', zip(docxEntries, { centralSize: 0xffffffff })],
    [
      'ZIP64 extra fields',
      zip([
        { ...docxEntries[0]!, centralExtra: Buffer.from([0x01, 0x00, 0x00, 0x00]) },
        docxEntries[1]!,
      ]),
    ],
    ['multi-disk metadata', zip(docxEntries, { disk: 1 })],
    [
      'an unsupported compression method',
      zip([{ ...docxEntries[0]!, method: 99 }, docxEntries[1]!]),
    ],
  ])('rejects %s', async (_reason, archive) => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    '../word/document.xml',
    '..\\word\\document.xml',
    '/word/document.xml',
    'C:/word/document.xml',
  ])('rejects path traversal or absolute ZIP entry %s', async (unsafeName) => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = zip([docxEntries[0]!, { name: unsafeName }]);
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'a slash-suffixed entry containing data',
      zip([docxEntries[0]!, { name: 'word/document.xml/', data: Buffer.from('not a directory') }]),
    ],
    [
      'a non-slash entry carrying DOS directory attributes',
      zip([docxEntries[0]!, { ...docxEntries[1]!, externalAttributes: 0x10 }]),
    ],
    [
      'a Unix symlink entry',
      zip([docxEntries[0]!, { ...docxEntries[1]!, externalAttributes: 0xa000 << 16 }]),
    ],
    [
      'a Unix FIFO entry',
      zip([docxEntries[0]!, { ...docxEntries[1]!, externalAttributes: 0x1000 << 16 }]),
    ],
    [
      'a Unix character-device entry',
      zip([docxEntries[0]!, { ...docxEntries[1]!, externalAttributes: 0x2000 << 16 }]),
    ],
    [
      'a Unix socket entry',
      zip([docxEntries[0]!, { ...docxEntries[1]!, externalAttributes: 0xc000 << 16 }]),
    ],
  ])('rejects directory masquerading or a special file via %s', async (_reason, archive) => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts an empty slash-suffixed directory without requiring platform-specific attributes', async () => {
    const prisma = successfulUploadPrisma();
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = zip([{ name: 'word/' }, ...docxEntries]);
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'directory.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).resolves.toMatchObject({ id: 'a1' });
  });

  it('rejects archives with more than 1000 entries', async () => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const archive = zip(
      Array.from({ length: 1001 }, (_, index) => ({ name: `word/${index}.xml` })),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'one expanded entry above 50 MiB',
      zip([
        {
          ...docxEntries[0]!,
          uncompressedSize: 50 * 1024 * 1024 + 1,
          localUncompressedSize: 50 * 1024 * 1024 + 1,
        },
        docxEntries[1]!,
      ]),
    ],
    [
      'one compressed entry above 50 MiB',
      zip([
        {
          ...docxEntries[0]!,
          compressedSize: 50 * 1024 * 1024 + 1,
          localCompressedSize: 50 * 1024 * 1024 + 1,
        },
        docxEntries[1]!,
      ]),
    ],
    [
      'more than 100 MiB cumulative expansion',
      zip([
        {
          name: '[Content_Types].xml',
          data: Buffer.from('a'),
          method: 8,
          uncompressedSize: 40 * 1024 * 1024,
          localUncompressedSize: 40 * 1024 * 1024,
        },
        {
          name: 'word/document.xml',
          data: Buffer.from('b'),
          method: 8,
          uncompressedSize: 40 * 1024 * 1024,
          localUncompressedSize: 40 * 1024 * 1024,
        },
        {
          name: 'word/styles.xml',
          data: Buffer.from('c'),
          method: 8,
          uncompressedSize: 40 * 1024 * 1024,
          localUncompressedSize: 40 * 1024 * 1024,
        },
      ]),
    ],
    [
      'an abnormal compression ratio',
      zip([
        {
          ...docxEntries[0]!,
          data: Buffer.from('x'),
          method: 8,
          uncompressedSize: 2 * 1024 * 1024,
          localUncompressedSize: 2 * 1024 * 1024,
        },
        docxEntries[1]!,
      ]),
    ],
  ])(
    'rejects %s from ZIP metadata without allocating expanded contents',
    async (_reason, archive) => {
      const service = new AttachmentsService(
        {} as never,
        { assertCustomerManager: vi.fn() } as never,
        await root(),
      );
      await expect(
        service.upload('u1', 'c1', {
          originalname: 'bad.docx',
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: archive.length,
          buffer: archive,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each([
    ['a truncated EOCD', zip(docxEntries).subarray(0, zip(docxEntries).length - 1)],
    [
      'a truncated central directory',
      (() => {
        const value = zip(docxEntries);
        return Buffer.concat([
          value.subarray(0, value.length - 23),
          value.subarray(value.length - 22),
        ]);
      })(),
    ],
    ['a central directory range outside the file', zip(docxEntries, { centralOffset: 0xffffff00 })],
    ['a central directory size that does not end at EOCD', zip(docxEntries, { centralSize: 1 })],
    [
      'an entry count inconsistent with the central directory',
      zip(docxEntries, { entriesOnDisk: 3, totalEntries: 3 }),
    ],
  ])('rejects malformed ZIP structure: %s', async (_reason, archive) => {
    const service = new AttachmentsService(
      {} as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'bad.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: archive.length,
        buffer: archive,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'DOCX missing [Content_Types].xml',
      'missing.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zip([docxEntries[1]!]),
    ],
    [
      'DOCX missing word/document.xml',
      'missing.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zip([docxEntries[0]!]),
    ],
    [
      'XLSX missing [Content_Types].xml',
      'missing.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      zip([xlsxEntries[1]!]),
    ],
    [
      'XLSX missing xl/workbook.xml',
      'missing.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      zip([xlsxEntries[0]!]),
    ],
    [
      'XLSX package disguised as DOCX',
      'wrong.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zip(xlsxEntries),
    ],
    [
      'DOCX package disguised as XLSX',
      'wrong.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      zip(docxEntries),
    ],
  ])(
    'rejects wrong OOXML package contents: %s',
    async (_reason, originalname, mimetype, archive) => {
      const service = new AttachmentsService(
        {} as never,
        { assertCustomerManager: vi.fn() } as never,
        await root(),
      );
      await expect(
        service.upload('u1', 'c1', {
          originalname,
          mimetype,
          size: archive.length,
          buffer: archive,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('publishes a validated file under a random fixed-format key and persists only metadata', async () => {
    const prisma = successfulUploadPrisma();
    const customers = { assertCustomerManager: vi.fn().mockResolvedValue(undefined) };
    const storageRoot = await root();
    const service = new AttachmentsService(prisma as never, customers as never, storageRoot);
    const result = await service.upload('u1', 'c1', {
      originalname: '../contract\u0000.pdf',
      mimetype: 'application/pdf',
      size: pdf.length,
      buffer: pdf,
    });
    const storageKey = prisma.attachment.create.mock.calls[0]![0].data.storageKey as string;
    expect(storageKey).toMatch(/^customer-contract\/[0-9a-f]{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(result.originalName).toBe('contract.pdf');
    expect(await readFile(join(storageRoot, storageKey))).toEqual(pdf);
    expect(prisma.attachment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resourceType: 'CUSTOMER_CONTRACT',
        resourceId: 'c1',
        customer: {
          connect: expect.objectContaining({
            id: 'c1',
            status: { not: 'ARCHIVED' },
            deletedAt: null,
            projects: expect.any(Object),
          }),
        },
        uploadedBy: { connect: { id: 'u1' } },
      }),
      select: expect.any(Object),
    });
  });

  it('fsyncs the shard directory before publishing and after removing the temp entry', async () => {
    const events: string[] = [];
    const prisma = successfulUploadPrisma();
    prisma.attachment.updateMany.mockImplementation(async (input: Record<string, unknown>) => {
      const data = input.data as Record<string, unknown> | undefined;
      if (data && Object.hasOwn(data, 'storagePublishedAt')) events.push('db-published');
      return { count: 1 };
    });
    class DirectoryDurabilityService extends AttachmentsService {
      protected override async syncStorageDirectory(handle: { sync(): Promise<void> }) {
        events.push('directory-sync');
        await handle.sync();
      }

      protected override async removeStoragePath(path: string, options?: { force?: boolean }) {
        events.push('temp-remove');
        return super.removeStoragePath(path, options);
      }
    }
    const service = new DirectoryDurabilityService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      await root(),
    );

    await service.upload('u1', 'c1', {
      originalname: 'contract.pdf',
      mimetype: 'application/pdf',
      size: pdf.length,
      buffer: pdf,
    });

    expect(events).toEqual(['directory-sync', 'db-published', 'temp-remove', 'directory-sync']);
  });

  it.each(['open', 'write', 'sync', 'close'] as const)(
    'retires an unpublished pending row when temp %s fails',
    async (stage) => {
      const storageRoot = await root();
      const primary = Object.assign(new Error(`${stage} failed`), { code: 'EIO' });
      const close = vi.fn().mockImplementation(async () => {
        if (stage === 'close') throw primary;
      });
      const handle = {
        writeFile: vi.fn().mockImplementation(async () => {
          if (stage === 'write') throw primary;
        }),
        sync: vi.fn().mockImplementation(async () => {
          if (stage === 'sync') throw primary;
        }),
        close,
      };
      const prisma = {
        attachment: {
          create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      class TempIoFailureService extends AttachmentsService {
        protected override async openUploadTemp() {
          if (stage === 'open') throw primary;
          return handle as never;
        }
      }
      const service = new TempIoFailureService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      await expect(
        service.upload('u1', 'c1', {
          originalname: 'contract.pdf',
          mimetype: 'application/pdf',
          size: pdf.length,
          buffer: pdf,
        }),
      ).rejects.toBe(primary);
      expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'pending-1', status: 'PENDING' },
      });
      if (stage !== 'open') expect(close).toHaveBeenCalledOnce();
    },
  );

  it('preserves the original write failure when close also fails', async () => {
    const storageRoot = await root();
    const writeError = Object.assign(new Error('write failed'), { code: 'EIO' });
    const closeError = Object.assign(new Error('close failed'), { code: 'EBADF' });
    const prisma = {
      attachment: {
        create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    class CombinedIoFailureService extends AttachmentsService {
      protected override async openUploadTemp() {
        return {
          writeFile: vi.fn().mockRejectedValue(writeError),
          sync: vi.fn(),
          close: vi.fn().mockRejectedValue(closeError),
        } as never;
      }
    }
    const service = new CombinedIoFailureService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toBe(writeError);
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
      where: { id: 'pending-1', status: 'PENDING' },
    });
  });

  it('leaves no attachment directories when creating the durable pending row fails', async () => {
    const storageRoot = await root();
    const prisma = {
      attachment: { create: vi.fn().mockRejectedValue(new Error('pending create failed')) },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toThrow('pending create failed');
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it.each([
    ['root', 'startup', 0o750, async (storageRoot: string) => storageRoot],
    [
      'resource',
      'upload',
      0o770,
      async (storageRoot: string) => {
        const directory = join(storageRoot, 'customer-contract');
        await mkdir(directory, { mode: 0o700 });
        return directory;
      },
    ],
    [
      'shard',
      'download',
      0o777,
      async (storageRoot: string) => {
        const directory = join(storageRoot, 'customer-contract/aa');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return directory;
      },
    ],
  ] as const)(
    'fails closed for an unsafe %s directory during %s without touching an outside sentinel',
    async (_level, operation, mode, prepare) => {
      const storageRoot = await root();
      const outside = await root();
      const sentinel = join(outside, 'sentinel.pdf');
      await writeFile(sentinel, pdf, { mode: 0o600 });
      await openStorageWide(await prepare(storageRoot), mode);
      const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
      const storedPath = join(storageRoot, storageKey);
      let storageDevice = 1n;
      let storageInode = 2n;
      if (operation === 'download') {
        await writeFile(storedPath, pdf, { mode: 0o600 });
        const stored = await stat(storedPath);
        storageDevice = BigInt(stored.dev);
        storageInode = BigInt(stored.ino);
      }
      const prisma = {
        attachment: {
          create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: 'pending-1',
            originalName: 'x.pdf',
            mimeType: 'application/pdf',
            sizeBytes: pdf.length,
            status: 'ACTIVE',
            createdAt: new Date(),
          }),
          findFirst: vi.fn().mockResolvedValue({
            id: 'a1',
            storageKey,
            originalName: 'x.pdf',
            mimeType: 'application/pdf',
            sizeBytes: pdf.length,
            storageDevice,
            storageInode,
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      const result =
        operation === 'startup'
          ? service.onApplicationBootstrap()
          : operation === 'upload'
            ? service.upload('u1', 'c1', {
                originalname: 'x.pdf',
                mimetype: 'application/pdf',
                size: pdf.length,
                buffer: pdf,
              })
            : service.download('u1', 'c1', 'a1');
      await expect(result).rejects.toBeInstanceOf(BadRequestException);
      await expect(readFile(sentinel)).resolves.toEqual(pdf);
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a unified UNLINK_FAILED code when the source cannot be removed after linking',
    async () => {
      const storageRoot = await root();
      const outside = await root();
      const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
      const storedPath = join(storageRoot, storageKey);
      await mkdir(dirname(storedPath), { recursive: true, mode: 0o700 });
      await writeFile(storedPath, pdf, { mode: 0o600 });
      const stored = await stat(storedPath);
      const service = new AttachmentsService(
        {
          attachment: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'a1',
                storageKey,
                storageDevice: BigInt(stored.dev),
                storageInode: BigInt(stored.ino),
              },
            ]),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        } as never,
        { assertCustomerManager: vi.fn() } as never,
        storageRoot,
      );
      const unlinkFailure = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      vi.spyOn(
        service as unknown as { removeStoragePath: (p: string) => Promise<void> },
        'removeStoragePath',
      ).mockRejectedValue(unlinkFailure);

      await expect(service.reconcileStorageCleanup()).resolves.toEqual({ cleaned: 0, failed: 1 });
      expect(await readFile(storedPath)).toEqual(pdf);
      expect(outside).toBeTruthy();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a real directory whose ACL grants Everyone (Windows owner equivalent)',
    async () => {
      const storageRoot = await root();
      await openStorageWide(storageRoot, 0o777);
      const prisma = { attachment: { findMany: vi.fn() } };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn() } as never,
        storageRoot,
      );

      await expect(service.onApplicationBootstrap()).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.attachment.findMany).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.getuid === undefined)(
    'fails closed when the storage root is not owned by the runtime user',
    async () => {
      const storageRoot = await root();
      const actualUid = process.getuid!();
      vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
      const prisma = { attachment: { findMany: vi.fn() } };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn() } as never,
        storageRoot,
      );

      await expect(service.onApplicationBootstrap()).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.attachment.findMany).not.toHaveBeenCalled();
    },
  );

  describe.runIf(process.getuid?.() === 0)('real foreign-owner directory and file checks', () => {
    it.each([
      ['root', 'startup', async (storageRoot: string) => storageRoot],
      [
        'resource',
        'upload',
        async (storageRoot: string) => {
          const directory = join(storageRoot, 'customer-contract');
          await mkdir(directory, { mode: 0o700 });
          return directory;
        },
      ],
      [
        'shard',
        'download',
        async (storageRoot: string) => {
          const directory = join(storageRoot, 'customer-contract/aa');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          return directory;
        },
      ],
    ] as const)(
      'fails closed for a real foreign-owned %s directory during %s',
      async (_level, operation, prepare) => {
        const storageRoot = await root();
        const outside = await root();
        const sentinel = join(outside, 'sentinel.pdf');
        await writeFile(sentinel, pdf, { mode: 0o600 });
        const unsafe = await prepare(storageRoot);
        await chown(unsafe, 10002, 10002);
        const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
        const storedPath = join(storageRoot, storageKey);
        let storageDevice = 1n;
        let storageInode = 2n;
        if (operation === 'download') {
          await writeFile(storedPath, pdf, { mode: 0o600 });
          const stored = await stat(storedPath);
          storageDevice = BigInt(stored.dev);
          storageInode = BigInt(stored.ino);
        }
        const prisma = {
          attachment: {
            create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: vi.fn(),
            findFirst: vi.fn().mockResolvedValue({
              id: 'a1',
              storageKey,
              originalName: 'x.pdf',
              mimeType: 'application/pdf',
              sizeBytes: pdf.length,
              storageDevice,
              storageInode,
            }),
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        const service = new AttachmentsService(
          prisma as never,
          { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
          storageRoot,
        );

        const result =
          operation === 'startup'
            ? service.onApplicationBootstrap()
            : operation === 'upload'
              ? service.upload('u1', 'c1', {
                  originalname: 'x.pdf',
                  mimetype: 'application/pdf',
                  size: pdf.length,
                  buffer: pdf,
                })
              : service.download('u1', 'c1', 'a1');
        await expect(result).rejects.toBeInstanceOf(BadRequestException);
        await expect(readFile(sentinel)).resolves.toEqual(pdf);
      },
    );

    it('rejects download of a real foreign-owned final file', async () => {
      const storageRoot = await root();
      const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
      const storedPath = join(storageRoot, storageKey);
      await mkdir(dirname(storedPath), { recursive: true, mode: 0o700 });
      await writeFile(storedPath, pdf, { mode: 0o600 });
      const stored = await stat(storedPath);
      await chown(storedPath, 10002, 10002);
      const prisma = {
        attachment: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'a1',
            storageKey,
            originalName: 'x.pdf',
            mimeType: 'application/pdf',
            sizeBytes: pdf.length,
            storageDevice: BigInt(stored.dev),
            storageInode: BigInt(stored.ino),
          }),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      await expect(service.download('u1', 'c1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
      await expect(readFile(storedPath)).resolves.toEqual(pdf);
    });

    it.each(['archive', 'reconciliation'] as const)(
      'preserves storage for a real foreign-owned shard during %s',
      async (operation) => {
        const storageRoot = await root();
        const outside = await root();
        const sentinel = join(outside, 'sentinel.pdf');
        await writeFile(sentinel, pdf, { mode: 0o600 });
        const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
        const storedPath = join(storageRoot, storageKey);
        await mkdir(dirname(storedPath), { recursive: true, mode: 0o700 });
        await writeFile(storedPath, pdf, { mode: 0o600 });
        const stored = await stat(storedPath);
        await chown(dirname(storedPath), 10002, 10002);
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const attachment = {
          id: 'a1',
          storageKey,
          storageDevice: BigInt(stored.dev),
          storageInode: BigInt(stored.ino),
        };
        const prisma = {
          attachment: {
            findFirst: vi.fn().mockResolvedValue(attachment),
            findMany: vi.fn().mockResolvedValue([attachment]),
            updateMany,
          },
        };
        const service = new AttachmentsService(
          prisma as never,
          { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
          storageRoot,
        );

        if (operation === 'archive') {
          await expect(service.archive('u1', 'c1', 'a1')).resolves.toEqual({ ok: true });
        } else {
          await expect(service.reconcileStorageCleanup()).resolves.toEqual({
            cleaned: 0,
            failed: 1,
          });
        }
        await expect(readFile(storedPath)).resolves.toEqual(pdf);
        await expect(readFile(sentinel)).resolves.toEqual(pdf);
        expect(updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ storageDeletedAt: expect.any(Date) }),
          }),
        );
        expect(updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: {
              storageCleanupAttempts: { increment: 1 },
              storageCleanupLastError: 'INVALID_STORAGE_PATH',
            },
          }),
        );
      },
    );
  });

  it.each(['archive', 'reconciliation'] as const)(
    'fails closed for an unsafe shard directory during %s without deleting storage',
    async (operation) => {
      const storageRoot = await root();
      const outside = await root();
      const sentinel = join(outside, 'sentinel.pdf');
      await writeFile(sentinel, pdf, { mode: 0o600 });
      const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
      const storedPath = join(storageRoot, storageKey);
      await mkdir(dirname(storedPath), { recursive: true, mode: 0o700 });
      await writeFile(storedPath, pdf, { mode: 0o600 });
      const stored = await stat(storedPath);
      await openStorageWide(dirname(storedPath), 0o770);
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const attachment = {
        id: 'a1',
        storageKey,
        storageDevice: BigInt(stored.dev),
        storageInode: BigInt(stored.ino),
      };
      const prisma = {
        attachment: {
          findFirst: vi.fn().mockResolvedValue(attachment),
          findMany: vi.fn().mockResolvedValue([attachment]),
          updateMany,
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      if (operation === 'archive') {
        await expect(service.archive('u1', 'c1', 'a1')).resolves.toEqual({ ok: true });
      } else {
        await expect(service.reconcileStorageCleanup()).resolves.toEqual({ cleaned: 0, failed: 1 });
      }
      await expect(readFile(storedPath)).resolves.toEqual(pdf);
      await expect(readFile(sentinel)).resolves.toEqual(pdf);
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storageDeletedAt: expect.any(Date) }),
        }),
      );
    },
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'rejects upload when the customer-contract directory is a symlink outside the root',
    async () => {
      const storageRoot = await root();
      const outside = await root();
      await symlink(outside, join(storageRoot, 'customer-contract'), 'dir');
      const prisma = {
        attachment: {
          create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
          deleteMany: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      await expect(
        service.upload('u1', 'c1', {
          originalname: 'contract.pdf',
          mimetype: 'application/pdf',
          size: pdf.length,
          buffer: pdf,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await readdir(outside)).toEqual([]);
      expect(prisma.attachment.create).toHaveBeenCalledOnce();
      expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
      expect(prisma.attachment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'pending-1', status: 'PENDING' }),
          data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
        }),
      );
    },
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'rejects upload when the shard directory is a symlink outside the root',
    async () => {
      const storageRoot = await root();
      const outside = await root();
      await mkdir(join(storageRoot, 'customer-contract'));
      for (let index = 0; index < 256; index += 1) {
        await symlink(
          outside,
          join(storageRoot, 'customer-contract', index.toString(16).padStart(2, '0')),
          'dir',
        );
      }
      const prisma = {
        attachment: {
          create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
          deleteMany: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      await expect(
        service.upload('u1', 'c1', {
          originalname: 'contract.pdf',
          mimetype: 'application/pdf',
          size: pdf.length,
          buffer: pdf,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await readdir(outside)).toEqual([]);
      expect(prisma.attachment.create).toHaveBeenCalledOnce();
      expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
      expect(prisma.attachment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'pending-1', status: 'PENDING' }),
          data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
        }),
      );
    },
  );

  it('preserves an existing final file when no-clobber publication detects a collision', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const previous = Buffer.from('%PDF-1.7\nexisting attachment');
    await mkdir(join(storageRoot, 'customer-contract/aa'), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, previous, { mode: 0o600 });
    const previousStat = await stat(finalPath);
    const prisma = {
      attachment: {
        create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const uuids = [id];
    class CollisionAttachmentsService extends AttachmentsService {
      protected override createStorageId(): string {
        return uuids.shift()!;
      }
    }
    const service = new CollisionAttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(finalPath)).toEqual(previous);
    expect((await stat(finalPath)).ino).toBe(previousStat.ino);
    expect(await readdir(join(storageRoot, 'customer-contract/aa'))).toEqual([`${id}.pdf`]);
    expect(prisma.attachment.create).toHaveBeenCalledOnce();
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
      where: { id: 'pending-1', status: 'PENDING' },
    });
    expect(prisma.attachment.updateMany).toHaveBeenCalledOnce();
  });

  it.skipIf(!SYMLINK_SUPPORTED)(
    'preserves an existing final symlink and its outside target when publication collides',
    async () => {
      const storageRoot = await root();
      const outside = await root();
      const id = 'aa000000-0000-4000-8000-000000000000';
      const finalDirectory = join(storageRoot, 'customer-contract/aa');
      const finalPath = join(finalDirectory, `${id}.pdf`);
      const outsideFile = join(outside, 'existing.pdf');
      const previous = Buffer.from('%PDF-1.7\noutside attachment');
      await mkdir(finalDirectory, { recursive: true, mode: 0o700 });
      await writeFile(outsideFile, previous, { mode: 0o600 });
      await symlink(outsideFile, finalPath, 'file');
      const prisma = {
        attachment: {
          create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const uuids = [id];
      class CollisionAttachmentsService extends AttachmentsService {
        protected override createStorageId(): string {
          return uuids.shift()!;
        }
      }
      const service = new CollisionAttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      await expect(
        service.upload('u1', 'c1', {
          originalname: 'contract.pdf',
          mimetype: 'application/pdf',
          size: pdf.length,
          buffer: pdf,
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readlink(finalPath)).toBe(outsideFile);
      expect(await readFile(outsideFile)).toEqual(previous);
      expect(await readdir(finalDirectory)).toEqual([`${id}.pdf`]);
      expect(prisma.attachment.create).toHaveBeenCalledOnce();
      expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'pending-1', status: 'PENDING' },
      });
      expect(prisma.attachment.updateMany).toHaveBeenCalledOnce();
    },
  );

  it('keeps a durable pending upload when temp cleanup repeatedly fails after publication', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const tempPath = join(storageRoot, 'customer-contract/aa', `.${id}.pdf.pending`);
    const prisma = {
      attachment: {
        create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'pending-1',
          originalName: 'contract.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          status: 'ACTIVE',
          createdAt: new Date(),
        }),
      },
    };
    class TempCleanupFailureService extends AttachmentsService {
      protected override createStorageId(): string {
        return id;
      }

      protected override async removeStoragePath(path: string, options?: { force?: boolean }) {
        if (path.endsWith('.pending'))
          throw Object.assign(new Error('temp cleanup failed'), { code: 'EIO' });
        return rm(path, options);
      }
    }
    const service = new TempCleanupFailureService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toThrow('temp cleanup failed');
    expect(prisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageKey, status: 'PENDING', storagePublishedAt: null }),
      }),
    );
    expect(prisma.attachment.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'pending-1',
        status: 'PENDING',
        storageDevice: null,
        storageInode: null,
      },
      data: { storageDevice: expect.anything(), storageInode: expect.anything() },
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'pending-1', status: 'PENDING', storagePublishedAt: null },
      data: { storagePublishedAt: expect.any(Date) },
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: 'pending-1',
        status: 'PENDING',
        storageCleanupAttempts: { lt: 3 },
      },
      data: {
        storageCleanupAttempts: { increment: 1 },
        storageCleanupLastError: 'EIO',
      },
    });
    expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
    expect(await readFile(finalPath)).toEqual(pdf);
    expect(await readFile(tempPath)).toEqual(pdf);
    expect((await stat(finalPath)).ino).toBe((await stat(tempPath)).ino);

    const publishedInfo = await stat(finalPath);
    prisma.attachment.findMany
      .mockResolvedValueOnce([
        {
          id: 'pending-1',
          uploadedById: 'u1',
          customerId: 'c1',
          storageKey,
          storagePublishedAt: new Date(),
          storageDevice: BigInt(publishedInfo.dev),
          storageInode: BigInt(publishedInfo.ino),
        },
      ])
      .mockResolvedValueOnce([]);
    const restarted = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );
    await expect(restarted.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 0 });
    expect(await readFile(finalPath)).toEqual(pdf);
    await expect(stat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(prisma.attachment.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'pending-1' },
      select: expect.any(Object),
    });
  });

  it('keeps a durable published pending row when activation and retry persistence fail', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const prisma = {
      attachment: {
        create: vi.fn().mockResolvedValue({ id: 'pending-1' }),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 })
          .mockRejectedValueOnce(new Error('db activation failed'))
          .mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'pending-1',
          originalName: 'contract.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          status: 'ACTIVE',
          createdAt: new Date(),
        }),
      },
    };
    class PublishedCleanupFailureService extends AttachmentsService {
      protected override createStorageId(): string {
        return id;
      }

      protected override async removeStoragePath(path: string, options?: { force?: boolean }) {
        if (path === finalPath)
          throw Object.assign(new Error('published cleanup failed'), { code: 'EIO' });
        return rm(path, options);
      }
    }
    const service = new PublishedCleanupFailureService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toThrow('db activation failed');
    expect(prisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageKey, status: 'PENDING', storagePublishedAt: null }),
      }),
    );
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'pending-1',
        status: 'PENDING',
        storageDevice: null,
        storageInode: null,
      },
      data: { storageDevice: expect.anything(), storageInode: expect.anything() },
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'pending-1', status: 'PENDING', storagePublishedAt: null },
      data: { storagePublishedAt: expect.any(Date) },
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: 'pending-1',
        uploadedById: 'u1',
        customerId: 'c1',
        customer: { is: expect.objectContaining({ id: 'c1', projects: expect.any(Object) }) },
        status: 'PENDING',
        storagePublishedAt: { not: null },
      },
      data: { status: 'ACTIVE', storageCleanupAttempts: 0, storageCleanupLastError: null },
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(4, {
      where: {
        id: 'pending-1',
        status: 'PENDING',
        storageCleanupAttempts: { lt: 3 },
      },
      data: {
        storageCleanupAttempts: { increment: 1 },
        storageCleanupLastError: 'UNKNOWN_STORAGE_ERROR',
      },
    });
    expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
    expect(await readFile(finalPath)).toEqual(pdf);
    expect(await readdir(dirname(finalPath))).toEqual([basename(finalPath)]);

    const publishedInfo = await stat(finalPath);
    prisma.attachment.findMany
      .mockResolvedValueOnce([
        {
          id: 'pending-1',
          uploadedById: 'u1',
          customerId: 'c1',
          storageKey,
          storagePublishedAt: new Date(),
          storageDevice: BigInt(publishedInfo.dev),
          storageInode: BigInt(publishedInfo.ino),
        },
      ])
      .mockResolvedValueOnce([]);
    const restarted = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );
    await expect(restarted.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 0 });
    expect(await readFile(finalPath)).toEqual(pdf);
    expect(prisma.attachment.findUniqueOrThrow).toHaveBeenCalled();
  });

  it('does not activate a marked pending final when persisted file identity is missing', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, pdf, { mode: 0o600 });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              storageKey,
              storagePublishedAt: new Date(),
              storageDevice: null,
              storageInode: null,
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        findUniqueOrThrow: vi.fn(),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await service.onApplicationBootstrap();

    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pending-1', status: 'PENDING' }),
        data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
      }),
    );
    expect(await readFile(finalPath)).toEqual(pdf);
  });

  it('never creates a publication marker or activates an unmarked pending final', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, pdf, { mode: 0o600 });
    const identity = await stat(finalPath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              storageKey,
              storagePublishedAt: null,
              storageDevice: BigInt(identity.dev),
              storageInode: BigInt(identity.ino),
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        deleteMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await service.onApplicationBootstrap();

    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storagePublishedAt: expect.any(Date) }),
      }),
    );
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pending-1', status: 'PENDING' }),
        data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
      }),
    );
    expect(await readFile(finalPath)).toEqual(pdf);
  });

  it('preserves a pending row when its storage directory is missing', async () => {
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/aa000000-0000-4000-8000-000000000000.pdf';
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              storageKey,
              storagePublishedAt: null,
              storageDevice: 1n,
              storageInode: 2n,
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        deleteMany,
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await service.onApplicationBootstrap();

    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'pending-1',
        status: 'PENDING',
        storageCleanupAttempts: { lt: 3 },
      },
      data: {
        storageCleanupAttempts: { increment: 1 },
        storageCleanupLastError: 'PENDING_STORAGE_DIRECTORY_MISSING',
      },
    });
  });

  it('preserves matching temp evidence when an unmarked final has a different identity', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const tempPath = join(dirname(finalPath), `.${id}.pdf.pending`);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, Buffer.from('%PDF-1.7\nunrelated'), { mode: 0o600 });
    await writeFile(tempPath, pdf, { mode: 0o600 });
    const tempIdentity = await stat(tempPath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              storageKey,
              storagePublishedAt: null,
              storageDevice: BigInt(tempIdentity.dev),
              storageInode: BigInt(tempIdentity.ino),
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        deleteMany,
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await service.onApplicationBootstrap();

    await expect(readFile(finalPath)).resolves.toEqual(Buffer.from('%PDF-1.7\nunrelated'));
    await expect(readFile(tempPath)).resolves.toEqual(pdf);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pending-1', status: 'PENDING' }),
        data: {
          storageCleanupAttempts: { increment: 1 },
          storageCleanupLastError: 'INVALID_STORAGE_PATH',
        },
      }),
    );
  });

  it('preserves an unmarked temp-only pending upload as recovery evidence', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const tempPath = join(dirname(finalPath), `.${id}.pdf.pending`);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(tempPath, pdf, { mode: 0o600 });
    const identity = await stat(tempPath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              storageKey,
              storagePublishedAt: null,
              storageDevice: BigInt(identity.dev),
              storageInode: BigInt(identity.ino),
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        deleteMany,
        findUniqueOrThrow: vi.fn(),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await service.onApplicationBootstrap();

    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(tempPath)).resolves.toEqual(pdf);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'pending-1',
        status: 'PENDING',
        storageCleanupAttempts: { lt: 3 },
      },
      data: {
        storageCleanupAttempts: { increment: 1 },
        storageCleanupLastError: 'PENDING_PUBLICATION_MARKER_MISSING',
      },
    });
  });

  it('retires a marked temp-only pending upload without republishing or activating it', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const tempPath = join(dirname(finalPath), `.${id}.pdf.pending`);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(tempPath, pdf, { mode: 0o600 });
    const identity = await stat(tempPath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'pending-1',
              storageKey,
              storagePublishedAt: new Date(),
              storageDevice: BigInt(identity.dev),
              storageInode: BigInt(identity.ino),
            },
          ])
          .mockResolvedValueOnce([]),
        updateMany,
        deleteMany,
        findUniqueOrThrow: vi.fn(),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await service.onApplicationBootstrap();

    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(tempPath)).resolves.toEqual(pdf);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pending-1', status: 'PENDING' }),
        data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
      }),
    );
  });

  it.skipIf(!SYMLINK_SUPPORTED)(
    'rejects startup reconciliation when ATTACHMENTS_ROOT itself is a symlink',
    async () => {
      const actualRoot = await root();
      const parent = await root();
      const linkedRoot = join(parent, 'attachments-link');
      await symlink(actualRoot, linkedRoot, 'dir');
      const prisma = { attachment: { findMany: vi.fn() } };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn() } as never,
        linkedRoot,
      );

      await expect(service.onApplicationBootstrap()).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.attachment.findMany).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'rejects download through a symlinked shard without reading outside the root',
    async () => {
      const storageRoot = await root();
      const outside = await root();
      const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
      const outsideFile = join(outside, '00000000-0000-4000-8000-000000000000.pdf');
      await mkdir(join(storageRoot, 'customer-contract'));
      await writeFile(outsideFile, pdf);
      await symlink(outside, join(storageRoot, 'customer-contract/aa'), 'dir');
      const prisma = {
        attachment: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'a1',
            storageKey,
            originalName: 'x.pdf',
            mimeType: 'application/pdf',
            sizeBytes: pdf.length,
          }),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
        storageRoot,
      );

      await expect(service.download('u1', 'c1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
      expect(await readFile(outsideFile)).toEqual(pdf);
    },
  );

  it.skipIf(!SYMLINK_SUPPORTED)(
    'does not clean an outside file through a symlinked shard during reconciliation',
    async () => {
      const storageRoot = await root();
      const outside = await root();
      const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
      const outsideFile = join(outside, '00000000-0000-4000-8000-000000000000.pdf');
      await mkdir(join(storageRoot, 'customer-contract'));
      await writeFile(outsideFile, pdf);
      await symlink(outside, join(storageRoot, 'customer-contract/aa'), 'dir');
      const prisma = {
        attachment: {
          findMany: vi.fn().mockResolvedValue([{ id: 'a1', storageKey }]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn() } as never,
        storageRoot,
      );
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.reconcileStorageCleanup()).resolves.toEqual({ cleaned: 0, failed: 1 });
      expect(await readFile(outsideFile)).toEqual(pdf);
      expect(prisma.attachment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'a1' }),
          data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
        }),
      );
    },
  );

  it('removes the published file when database persistence fails', async () => {
    const prisma = { attachment: { create: vi.fn().mockRejectedValue(new Error('db failed')) } };
    const storageRoot = await root();
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );
    await expect(
      service.upload('u1', 'c1', {
        originalname: 'contract.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toThrow('db failed');
    const { readdir } = await import('node:fs/promises');
    expect(
      (await readdir(storageRoot, { recursive: true })).filter((entry) =>
        /\.(?:pdf|png|jpe?g|docx|xlsx|pending)$/.test(entry),
      ),
    ).toEqual([]);
  });

  it('does not expose storage keys, hashes or resource ids in public upload responses', async () => {
    const prisma = successfulUploadPrisma();
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      await root(),
    );
    const result = await service.upload('u1', 'c1', {
      originalname: 'x.pdf',
      mimetype: 'application/pdf',
      size: pdf.length,
      buffer: pdf,
    });
    expect(result).not.toHaveProperty('storageKey');
    expect(result).not.toHaveProperty('sha256');
    expect(result).not.toHaveProperty('resourceId');
    expect(prisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ storageKey: true, sha256: true, resourceId: true }),
      }),
    );
  });

  it('re-authorizes upload and archive independently before side effects', async () => {
    const prisma = { attachment: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() } };
    const customers = {
      assertCustomerManager: vi.fn().mockRejectedValue(new ForbiddenException()),
    };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(
      service.upload('u1', 'c1', {
        originalname: 'x.pdf',
        mimetype: 'application/pdf',
        size: pdf.length,
        buffer: pdf,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.archive('u1', 'c1', 'a1')).rejects.toBeInstanceOf(ForbiddenException);

    expect(customers.assertCustomerManager).toHaveBeenCalledTimes(2);
    expect(prisma.attachment.create).not.toHaveBeenCalled();
    expect(prisma.attachment.findFirst).not.toHaveBeenCalled();
    expect(prisma.attachment.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a downloaded regular file whose persisted identity has been replaced', async () => {
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
    const storedPath = join(storageRoot, storageKey);
    const ownedPath = join(storageRoot, 'owned.pdf');
    await mkdir(dirname(storedPath), { recursive: true, mode: 0o700 });
    await writeFile(ownedPath, pdf, { mode: 0o600 });
    const original = await stat(ownedPath);
    const replacement = Buffer.from('%PDF-1.7\nreplacement');
    await writeFile(storedPath, replacement, { mode: 0o600 });
    const prisma = {
      attachment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'a1',
          storageKey,
          originalName: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: replacement.length,
          storageDevice: BigInt(original.dev),
          storageInode: BigInt(original.ino),
        }),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(service.download('u1', 'c1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(storedPath)).resolves.toEqual(replacement);
  });

  it('rejects a downloaded file whose mode is not exactly 0600', async () => {
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
    const storedPath = join(storageRoot, storageKey);
    await mkdir(dirname(storedPath), { recursive: true, mode: 0o700 });
    await writeFile(storedPath, pdf, { mode: 0o640 });
    await openStorageWide(storedPath, 0o640, 'file');
    const stored = await stat(storedPath);
    const prisma = {
      attachment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'a1',
          storageKey,
          originalName: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          storageDevice: BigInt(stored.dev),
          storageInode: BigInt(stored.ino),
        }),
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn().mockResolvedValue(undefined) } as never,
      storageRoot,
    );

    await expect(service.download('u1', 'c1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(storedPath)).resolves.toEqual(pdf);
  });

  it.each(['final', 'temp'] as const)(
    'preserves an unsafe-mode pending %s file and refuses activation',
    async (entry) => {
      const storageRoot = await root();
      const id = 'aa000000-0000-4000-8000-000000000000';
      const storageKey = `customer-contract/aa/${id}.pdf`;
      const finalPath = join(storageRoot, storageKey);
      const tempPath = join(dirname(finalPath), `.${id}.pdf.pending`);
      const pendingPath = entry === 'final' ? finalPath : tempPath;
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      await writeFile(pendingPath, pdf, { mode: 0o640 });
      await openStorageWide(pendingPath, 0o640, 'file');
      const identity = await stat(pendingPath);
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        attachment: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: 'pending-unsafe',
                storageKey,
                storagePublishedAt: entry === 'final' ? new Date() : null,
                storageDevice: BigInt(identity.dev),
                storageInode: BigInt(identity.ino),
              },
            ])
            .mockResolvedValueOnce([]),
          updateMany,
          deleteMany: vi.fn(),
          findUniqueOrThrow: vi.fn(),
        },
      };
      const service = new AttachmentsService(
        prisma as never,
        { assertCustomerManager: vi.fn() } as never,
        storageRoot,
      );

      await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 0 });
      await expect(readFile(pendingPath)).resolves.toEqual(pdf);
      expect(updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'pending-unsafe', status: 'PENDING' }),
          data: expect.objectContaining({ storageCleanupAttempts: { increment: 1 } }),
        }),
      );
    },
  );

  it('preserves an unsafe-mode quarantine during archived reconciliation', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const attachmentId = 'attachment-unsafe-quarantine';
    const quarantineName = `.${basename(finalPath)}.cleanup-${createHash('sha256').update(attachmentId).digest('hex').slice(0, 32)}`;
    const quarantinePath = join(dirname(finalPath), quarantineName);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(quarantinePath, pdf, { mode: 0o640 });
    await openStorageWide(quarantinePath, 0o640, 'file');
    const identity = await stat(quarantinePath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: attachmentId,
              storageKey,
              storageDevice: BigInt(identity.dev),
              storageInode: BigInt(identity.ino),
            },
          ]),
        updateMany,
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 1 });
    await expect(readFile(quarantinePath)).resolves.toEqual(pdf);
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageDeletedAt: expect.any(Date) }),
      }),
    );
  });

  it('re-authorizes customer management on every download', async () => {
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
    await mkdir(join(storageRoot, 'customer-contract/aa'), { recursive: true, mode: 0o700 });
    await writeFile(join(storageRoot, storageKey), pdf);
    const prisma = {
      attachment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'a1',
          resourceId: 'c1',
          storageKey,
          originalName: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
        }),
      },
    };
    const customers = {
      get: vi.fn().mockResolvedValue({ id: 'c1', canManage: false }),
      assertCustomerManager: vi.fn().mockRejectedValue(new ForbiddenException()),
    };
    const service = new AttachmentsService(prisma as never, customers as never, storageRoot);
    await expect(service.download('u1', 'c1', 'a1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(customers.assertCustomerManager).toHaveBeenCalledWith('u1', 'c1');
    expect(prisma.attachment.findFirst).not.toHaveBeenCalled();
  });

  it('returns 403 instead of listing contracts for an ordinary customer member', async () => {
    const prisma = { attachment: { findMany: vi.fn() } };
    const customers = {
      get: vi.fn().mockResolvedValue({ id: 'c1', canManage: false }),
      assertCustomerManager: vi.fn().mockRejectedValue(new ForbiddenException()),
    };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(service.listWithCapability('u1', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(customers.assertCustomerManager).toHaveBeenCalledWith('u1', 'c1');
    expect(prisma.attachment.findMany).not.toHaveBeenCalled();
  });

  it('re-authorizes each contract list call on the same service instance', async () => {
    const items = [{ id: 'a1', originalName: 'x.pdf' }];
    const prisma = { attachment: { findMany: vi.fn().mockResolvedValue(items) } };
    const customers = {
      get: vi.fn().mockResolvedValue({ id: 'c1', canManage: true }),
      assertCustomerManager: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new ForbiddenException()),
    };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(service.listWithCapability('u1', 'c1')).resolves.toEqual({
      items,
      canManage: true,
    });
    await expect(service.listWithCapability('u1', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(customers.assertCustomerManager).toHaveBeenCalledTimes(2);
    expect(prisma.attachment.findMany).toHaveBeenCalledTimes(1);
  });

  it('preserves 404 customer anti-enumeration before listing attachments', async () => {
    const prisma = { attachment: { findMany: vi.fn() } };
    const customers = {
      get: vi.fn().mockRejectedValue(new NotFoundException()),
      assertCustomerManager: vi.fn().mockRejectedValue(new NotFoundException()),
    };
    const service = new AttachmentsService(prisma as never, customers as never, await root());

    await expect(service.list('u1', 'c-other')).rejects.toBeInstanceOf(NotFoundException);
    expect(customers.assertCustomerManager).toHaveBeenCalledWith('u1', 'c-other');
    expect(prisma.attachment.findMany).not.toHaveBeenCalled();
  });

  it('does not expose the attachment storage key or resource id from download', async () => {
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
    await mkdir(join(storageRoot, 'customer-contract/aa'), { recursive: true, mode: 0o700 });
    const storedPath = join(storageRoot, storageKey);
    await writeFile(storedPath, pdf, { mode: 0o600 });
    const stored = await stat(storedPath);
    const prisma = {
      attachment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'a1',
          resourceId: 'c1',
          storageKey,
          originalName: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          storageDevice: BigInt(stored.dev),
          storageInode: BigInt(stored.ino),
        }),
      },
    };
    const customers = {
      get: vi.fn().mockResolvedValue({ id: 'c1', canManage: true }),
      assertCustomerManager: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AttachmentsService(prisma as never, customers as never, storageRoot);

    const result = await service.download('u1', 'c1', 'a1');

    expect(result).not.toHaveProperty('storageKey');
    expect(result).not.toHaveProperty('resourceId');
    expect(result).toMatchObject({ id: 'a1', originalName: 'x.pdf', sizeBytes: pdf.length });
    // 显式释放流句柄：Node 不再允许 GC 关闭 FileHandle。
    result.stream.destroy();
  });

  it('never deletes an archived final whose persisted identity does not match', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const ownedPath = join(storageRoot, 'owned.pdf');
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(ownedPath, pdf, { mode: 0o600 });
    const owned = await stat(ownedPath);
    const replacement = Buffer.from('%PDF-1.7\nreplacement');
    await writeFile(finalPath, replacement, { mode: 0o600 });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 'attachment-1',
              storageKey,
              storageDevice: BigInt(owned.dev),
              storageInode: BigInt(owned.ino),
            },
          ]),
        updateMany,
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 1 });
    await expect(readFile(finalPath)).resolves.toEqual(replacement);
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageDeletedAt: expect.any(Date) }),
      }),
    );
  });

  it('does not mark cleanup complete when a same-inode quarantine races the no-clobber move', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const attachmentId = 'attachment-same-inode-race';
    const quarantineName = `.${basename(finalPath)}.cleanup-${createHash('sha256').update(attachmentId).digest('hex').slice(0, 32)}`;
    const quarantinePath = join(dirname(finalPath), quarantineName);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, pdf, { mode: 0o600 });
    const owned = await stat(finalPath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: attachmentId,
              storageKey,
              storageDevice: BigInt(owned.dev),
              storageInode: BigInt(owned.ino),
            },
          ]),
        updateMany,
      },
    };
    class SameInodeCleanupRaceService extends AttachmentsService {
      protected override async moveStoragePathNoReplace(
        source: string,
        destination: string,
        directoryFd?: number,
      ) {
        await link(source, destination);
        return super.moveStoragePathNoReplace(source, destination, directoryFd);
      }
    }
    const service = new SameInodeCleanupRaceService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 1 });
    await expect(readFile(finalPath)).resolves.toEqual(pdf);
    await expect(readFile(quarantinePath)).resolves.toEqual(pdf);
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageDeletedAt: expect.any(Date) }),
      }),
    );
  });

  it('never replaces a quarantine entry created between the precheck and cleanup move', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const attachmentId = 'attachment-race';
    const quarantineName = `.${basename(finalPath)}.cleanup-${createHash('sha256').update(attachmentId).digest('hex').slice(0, 32)}`;
    const quarantinePath = join(dirname(finalPath), quarantineName);
    const raced = Buffer.from('%PDF-1.7\nraced quarantine');
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, pdf, { mode: 0o600 });
    const owned = await stat(finalPath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: attachmentId,
              storageKey,
              storageDevice: BigInt(owned.dev),
              storageInode: BigInt(owned.ino),
            },
          ]),
        updateMany,
      },
    };
    class CleanupRaceService extends AttachmentsService {
      protected override async moveStoragePathNoReplace(
        source: string,
        destination: string,
        directoryFd?: number,
      ) {
        await writeFile(destination, raced, { mode: 0o600 });
        return super.moveStoragePathNoReplace(source, destination, directoryFd);
      }
    }
    const service = new CleanupRaceService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 1 });
    await expect(readFile(finalPath)).resolves.toEqual(pdf);
    await expect(readFile(quarantinePath)).resolves.toEqual(raced);
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageDeletedAt: expect.any(Date) }),
      }),
    );
  });

  it('never replaces a pre-existing quarantine entry during archived cleanup', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const attachmentId = 'attachment-1';
    const quarantineName = `.${basename(finalPath)}.cleanup-${createHash('sha256').update(attachmentId).digest('hex').slice(0, 32)}`;
    const quarantinePath = join(dirname(finalPath), quarantineName);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(finalPath, pdf, { mode: 0o600 });
    const owned = await stat(finalPath);
    const preexisting = Buffer.from('%PDF-1.7\npreexisting quarantine');
    await writeFile(quarantinePath, preexisting, { mode: 0o600 });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: attachmentId,
              storageKey,
              storageDevice: BigInt(owned.dev),
              storageInode: BigInt(owned.ino),
            },
          ]),
        updateMany,
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 0, failed: 1 });
    await expect(readFile(finalPath)).resolves.toEqual(pdf);
    await expect(readFile(quarantinePath)).resolves.toEqual(preexisting);
  });

  it('finishes deletion from a durable deterministic quarantine after restart', async () => {
    const storageRoot = await root();
    const id = 'aa000000-0000-4000-8000-000000000000';
    const storageKey = `customer-contract/aa/${id}.pdf`;
    const finalPath = join(storageRoot, storageKey);
    const attachmentId = 'attachment-1';
    const quarantineName = `.${basename(finalPath)}.cleanup-${createHash('sha256').update(attachmentId).digest('hex').slice(0, 32)}`;
    const quarantinePath = join(dirname(finalPath), quarantineName);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await writeFile(quarantinePath, pdf, { mode: 0o600 });
    const owned = await stat(quarantinePath);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attachment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: attachmentId,
              storageKey,
              storageDevice: BigInt(owned.dev),
              storageInode: BigInt(owned.ino),
            },
          ]),
        updateMany,
      },
    };
    const service = new AttachmentsService(
      prisma as never,
      { assertCustomerManager: vi.fn() } as never,
      storageRoot,
    );

    await expect(service.onApplicationBootstrap()).resolves.toEqual({ cleaned: 1, failed: 0 });
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: attachmentId, status: 'ARCHIVED', storageDeletedAt: null },
      data: { storageDeletedAt: expect.any(Date), storageCleanupLastError: null },
    });
  });

  it('persists archive cleanup intent and retries it after a deletion failure or process restart', async () => {
    const storageRoot = await root();
    const storageKey = 'customer-contract/aa/00000000-0000-4000-8000-000000000000.pdf';
    const storedPath = join(storageRoot, storageKey);
    await mkdir(storedPath, { recursive: true, mode: 0o700 });
    const prisma = {
      attachment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'a1',
          storageKey,
          storageDevice: 1n,
          storageInode: 2n,
        }),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 'a1', storageKey, storageDevice: 1n, storageInode: 2n }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const customers = { assertCustomerManager: vi.fn().mockResolvedValue(undefined) };
    const service = new AttachmentsService(prisma as never, customers as never, storageRoot);
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.archive('u1', 'c1', 'a1')).resolves.toEqual({ ok: true });
    expect(prisma.attachment.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        id: 'a1',
        customerId: 'c1',
        customer: { is: expect.objectContaining({ id: 'c1', projects: expect.any(Object) }) },
        status: 'ACTIVE',
        deletedAt: null,
      }),
      data: {
        status: 'ARCHIVED',
        deletedAt: expect.any(Date),
        storageDeletedAt: null,
        storageCleanupAttempts: 0,
        storageCleanupLastError: null,
      },
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'a1',
        status: 'ARCHIVED',
        storageDeletedAt: null,
        storageCleanupAttempts: { lt: 3 },
      },
      data: {
        storageCleanupAttempts: { increment: 1 },
        storageCleanupLastError: 'INVALID_STORAGE_PATH',
      },
    });
    expect(warning).toHaveBeenCalledWith('attachment storage cleanup deferred', {
      attachmentId: 'a1',
      errorCode: 'INVALID_STORAGE_PATH',
    });

    await rm(storedPath, { recursive: true, force: true });
    const restarted = new AttachmentsService(prisma as never, customers as never, storageRoot);
    await expect(restarted.onApplicationBootstrap()).resolves.toEqual({ cleaned: 1, failed: 0 });
    expect(prisma.attachment.findMany).toHaveBeenCalledWith({
      where: { status: 'ARCHIVED', storageDeletedAt: null, storageCleanupAttempts: { lt: 3 } },
      select: { id: true, storageKey: true, storageDevice: true, storageInode: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    expect(prisma.attachment.updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: 'a1', status: 'ARCHIVED', storageDeletedAt: null },
      data: { storageDeletedAt: expect.any(Date), storageCleanupLastError: null },
    });
  });
});
