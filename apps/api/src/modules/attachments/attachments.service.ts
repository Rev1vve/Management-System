import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import { type ChildProcess, spawn } from 'node:child_process';
import { link, lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS } from '../authorization/permission.constants';
import { CustomersService } from '../customers/customers.service';
import {
  assertPrivateDirectory as assertPrivateDirectoryMetadata,
  assertPrivateDirectoryPath,
  assertPrivateFile as assertPrivateFileMetadata,
  assertPrivateAclOnly,
  type DirectoryAnchor,
  openPrivateDirectory,
  openPrivateFileRead,
  requireAnchoredStorage,
  STORAGE_PLATFORM,
  uploadTempOpenFlags,
} from './storage-platform';

export const ATTACHMENTS_ROOT = Symbol('ATTACHMENTS_ROOT');
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const CUSTOMER_CONTRACT = 'CUSTOMER_CONTRACT' as const;

export interface BufferedUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const TYPES = {
  '.pdf': {
    mime: 'application/pdf',
    magic: (value: Buffer) => value.subarray(0, 5).equals(Buffer.from('%PDF-')),
  },
  '.png': {
    mime: 'image/png',
    magic: (value: Buffer) =>
      value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  '.jpg': {
    mime: 'image/jpeg',
    magic: (value: Buffer) =>
      value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff,
  },
  '.jpeg': {
    mime: 'image/jpeg',
    magic: (value: Buffer) =>
      value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff,
  },
  '.docx': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: (value: Buffer) => validOoxml(value, 'word/'),
  },
  '.xlsx': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    magic: (value: Buffer) => validOoxml(value, 'xl/'),
  },
} as const;

const PUBLIC_ATTACHMENT_SELECT = {
  id: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  createdAt: true,
} as const;

const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_RATIO = 100;
const ZIP_RATIO_THRESHOLD = 1024 * 1024;
type PendingPublication = 'NONE' | 'ATTEMPTED' | 'LINKED' | 'DURABLE';

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hasZip64Extra(extra: Buffer): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) return true;
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length || id === 0x0001) return true;
    offset += size;
  }
  return false;
}

function safeZipName(bytes: Buffer, flags: number): string | null {
  if (bytes.length === 0 || bytes.length > 512 || bytes.includes(0) || bytes.includes(0x5c))
    return null;
  let name: string;
  if ((flags & 0x0800) !== 0) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  } else {
    if (bytes.some((byte) => byte > 0x7f)) return null;
    name = bytes.toString('ascii');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/');
  if (
    parts.some(
      (part, index) => (!part && index !== parts.length - 1) || part === '.' || part === '..',
    )
  )
    return null;
  return name;
}

function validOoxml(value: Buffer, requiredPrefix: 'word/' | 'xl/'): boolean {
  try {
    if (value.length < 22) return false;
    const searchStart = Math.max(0, value.length - 22 - 0xffff);
    let eocdOffset = -1;
    let eocdCandidates = 0;
    for (let offset = value.length - 22; offset >= searchStart; offset -= 1) {
      if (
        value.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + value.readUInt16LE(offset + 20) === value.length
      ) {
        const candidateCentralSize = value.readUInt32LE(offset + 12);
        const candidateCentralOffset = value.readUInt32LE(offset + 16);
        if (
          candidateCentralSize !== 0xffffffff &&
          candidateCentralOffset !== 0xffffffff &&
          candidateCentralOffset + candidateCentralSize === offset
        ) {
          eocdCandidates += 1;
          if (eocdOffset < 0) eocdOffset = offset;
        }
      }
    }
    if (eocdOffset < 0 || eocdCandidates !== 1) return false;
    if (eocdOffset >= 20 && value.readUInt32LE(eocdOffset - 20) === 0x07064b50) return false;

    const disk = value.readUInt16LE(eocdOffset + 4);
    const centralDisk = value.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = value.readUInt16LE(eocdOffset + 8);
    const entryCount = value.readUInt16LE(eocdOffset + 10);
    const centralSize = value.readUInt32LE(eocdOffset + 12);
    const centralOffset = value.readUInt32LE(eocdOffset + 16);
    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount === 0 ||
      entryCount === 0xffff ||
      entryCount > MAX_ZIP_ENTRIES ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff ||
      centralOffset + centralSize !== eocdOffset
    )
      return false;

    const names = new Set<string>();
    const ranges: Array<[number, number]> = [];
    let expanded = 0;
    let offset = centralOffset;
    let hasTypes = false;
    let hasRequired = false;
    const requiredName = requiredPrefix === 'word/' ? 'word/document.xml' : 'xl/workbook.xml';

    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > eocdOffset || value.readUInt32LE(offset) !== 0x02014b50) return false;
      const flags = value.readUInt16LE(offset + 8);
      const method = value.readUInt16LE(offset + 10);
      const crc = value.readUInt32LE(offset + 16);
      const compressed = value.readUInt32LE(offset + 20);
      const uncompressed = value.readUInt32LE(offset + 24);
      const nameLength = value.readUInt16LE(offset + 28);
      const extraLength = value.readUInt16LE(offset + 30);
      const commentLength = value.readUInt16LE(offset + 32);
      const diskStart = value.readUInt16LE(offset + 34);
      const externalAttributes = value.readUInt32LE(offset + 38);
      const localOffset = value.readUInt32LE(offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      // bits 1-2 are deflate compression options, bit 3 is a bounded data descriptor,
      // and bit 11 is UTF-8 names. Encryption and every reserved bit stay rejected.
      if (
        end > eocdOffset ||
        (flags & ~0x080e) !== 0 ||
        diskStart !== 0 ||
        (method !== 0 && method !== 8) ||
        compressed === 0xffffffff ||
        uncompressed === 0xffffffff ||
        localOffset === 0xffffffff ||
        compressed > MAX_ZIP_ENTRY_BYTES ||
        uncompressed > MAX_ZIP_ENTRY_BYTES ||
        (method === 0 && compressed !== uncompressed) ||
        (uncompressed > 0 && compressed === 0) ||
        (uncompressed >= ZIP_RATIO_THRESHOLD && uncompressed / compressed > MAX_ZIP_RATIO)
      )
        return false;
      expanded += uncompressed;
      if (expanded > MAX_ZIP_EXPANDED_BYTES) return false;

      const nameBytes = value.subarray(offset + 46, offset + 46 + nameLength);
      const extra = value.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength,
      );
      const name = safeZipName(nameBytes, flags);
      if (!name || hasZip64Extra(extra) || names.has(name)) return false;
      names.add(name);

      const unixType = (externalAttributes >>> 16) & 0xf000;
      const directoryByName = name.endsWith('/');
      const directoryByAttribute = (externalAttributes & 0x10) !== 0 || unixType === 0x4000;
      const specialUnixType = unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000;
      if (
        specialUnixType ||
        (directoryByName && (compressed !== 0 || uncompressed !== 0)) ||
        (!directoryByName && directoryByAttribute)
      )
        return false;

      if (localOffset + 30 > centralOffset || value.readUInt32LE(localOffset) !== 0x04034b50)
        return false;
      const localFlags = value.readUInt16LE(localOffset + 6);
      const localMethod = value.readUInt16LE(localOffset + 8);
      const localCrc = value.readUInt32LE(localOffset + 14);
      const localCompressed = value.readUInt32LE(localOffset + 18);
      const localUncompressed = value.readUInt32LE(localOffset + 22);
      const localNameLength = value.readUInt16LE(localOffset + 26);
      const localExtraLength = value.readUInt16LE(localOffset + 28);
      const localNameStart = localOffset + 30;
      const dataStart = localNameStart + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressed;
      const usesDescriptor = (flags & 0x0008) !== 0;
      let entryEnd = dataEnd;
      if (
        localFlags !== flags ||
        localMethod !== method ||
        localNameLength !== nameLength ||
        dataEnd > centralOffset ||
        !value.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes) ||
        hasZip64Extra(value.subarray(localNameStart + localNameLength, dataStart))
      )
        return false;
      if (usesDescriptor) {
        // With bit 3 set, local CRC/sizes are deliberately unknown and must be zero.
        // The bounded descriptor may carry the optional signature; all values must
        // exactly repeat the authoritative central-directory record.
        if (localCrc !== 0 || localCompressed !== 0 || localUncompressed !== 0) return false;
        const hasDescriptorSignature =
          dataEnd + 4 <= centralOffset && value.readUInt32LE(dataEnd) === 0x08074b50;
        const descriptorOffset = dataEnd + (hasDescriptorSignature ? 4 : 0);
        if (
          descriptorOffset + 12 > centralOffset ||
          value.readUInt32LE(descriptorOffset) !== crc ||
          value.readUInt32LE(descriptorOffset + 4) !== compressed ||
          value.readUInt32LE(descriptorOffset + 8) !== uncompressed
        )
          return false;
        entryEnd = descriptorOffset + 12;
      } else if (
        localCrc !== crc ||
        localCompressed !== compressed ||
        localUncompressed !== uncompressed
      ) {
        return false;
      }

      const compressedData = value.subarray(dataStart, dataEnd);
      let expandedData: Buffer;
      if (method === 0) {
        expandedData = compressedData;
      } else {
        try {
          expandedData = inflateRawSync(compressedData, {
            maxOutputLength: Math.min(MAX_ZIP_ENTRY_BYTES + 1, uncompressed + 1),
          });
        } catch {
          return false;
        }
      }
      if (expandedData.length !== uncompressed || crc32(expandedData) !== crc) return false;

      if (ranges.some(([start, finish]) => localOffset < finish && entryEnd > start)) return false;
      ranges.push([localOffset, entryEnd]);

      if (!directoryByName && name === '[Content_Types].xml') hasTypes = true;
      if (!directoryByName && name === requiredName) hasRequired = true;
      offset = end;
    }
    ranges.sort(([left], [right]) => left - right);
    let coveredUntil = 0;
    for (const [start, finish] of ranges) {
      if (start !== coveredUntil) return false;
      coveredUntil = finish;
    }
    return offset === eocdOffset && coveredUntil === centralOffset && hasTypes && hasRequired;
  } catch {
    return false;
  }
}

export function validateAttachmentsRoot(value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error('ATTACHMENTS_ROOT 必须是配置的绝对路径');
  const normalized = resolve(value);
  if (normalized === sep) throw new Error('ATTACHMENTS_ROOT 不能是文件系统根目录');
  return normalized;
}

const MOVE_ERROR_MESSAGE = '附件清理原子移动失败';

function moveFailure(error: unknown, fallbackCode: string): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : fallbackCode;
  return Object.assign(new Error(MOVE_ERROR_MESSAGE), { code });
}

@Injectable()
export class AttachmentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly root: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(ATTACHMENTS_ROOT) root: string,
  ) {
    this.root = validateAttachmentsRoot(root);
  }

  protected createStorageId(): string {
    return randomUUID();
  }

  protected removeStoragePath(path: string, options?: { force?: boolean }) {
    return rm(path, options);
  }

  protected openUploadTemp(path: string) {
    return open(path, uploadTempOpenFlags(), 0o600);
  }

  protected syncStorageDirectory(anchor: DirectoryAnchor): Promise<void> {
    return anchor.sync();
  }

  protected moveStoragePathNoReplace(
    source: string,
    destination: string,
    directoryFd?: number,
  ): Promise<void> {
    requireAnchoredStorage();
    if (STORAGE_PLATFORM === 'win32') {
      // 硬链接建立失败（EEXIST）即目标已存在，天然 no-clobber；
      // 链接成功后再删除源，等价于 `mv -nT` 的"绝不覆盖"语义。
      // 删除失败（例如仍有打开句柄）必须与 Linux 的 MV_EXIT_* 一样统一错误形状，
      // 由上层按"清理未完成"记录，而不是把原始 fs 错误直接抛给调用方。
      return link(source, destination).then(
        () =>
          this.removeStoragePath(source).catch((error: unknown) => {
            // 链接已建立但源未删除：必须与 LINK_FAILED 一样走统一错误形状，
            // 上层据此记录"清理未完成"，而不是把原始 fs 错误直接抛出。
            throw moveFailure(error, 'UNLINK_FAILED');
          }),
        (error: unknown) => {
          throw moveFailure(error, 'LINK_FAILED');
        },
      );
    }
    return new Promise((resolveMove, rejectMove) => {
      // File descriptors opened by Node are close-on-exec. Explicitly duplicate
      // the anchored shard handle to fd 3 in the child; otherwise the
      // /proc/self/fd path names disappear after spawn and every real cleanup
      // fails even though in-process tests can still see them.
      const childSource =
        directoryFd === undefined ? source : join('/proc/self/fd/3', basename(source));
      const childDestination =
        directoryFd === undefined ? destination : join('/proc/self/fd/3', basename(destination));
      let child: ChildProcess;
      if (directoryFd === undefined) {
        child = spawn('/usr/bin/mv', ['-nT', childSource, childDestination], {
          stdio: 'ignore',
        });
      } else {
        child = spawn('/usr/bin/mv', ['-nT', childSource, childDestination], {
          stdio: ['ignore', 'ignore', 'ignore', directoryFd],
        });
      }
      child.once('error', rejectMove);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolveMove();
          return;
        }
        rejectMove(
          Object.assign(new Error(MOVE_ERROR_MESSAGE), {
            code: signal ? `SIGNAL_${signal}` : `MV_EXIT_${code ?? 'UNKNOWN'}`,
          }),
        );
      });
    });
  }

  private currentCustomerManager(userId: string, customerId: string) {
    return {
      id: customerId,
      status: { not: 'ARCHIVED' as const },
      deletedAt: null,
      projects: {
        some: {
          status: 'ACTIVE' as const,
          deletedAt: null,
          memberships: {
            some: {
              userId,
              roles: { some: { role: 'PROJECT_MANAGER' as const } },
              user: {
                status: 'ACTIVE' as const,
                deletedAt: null,
                systemRoles: {
                  some: {
                    systemRole: {
                      rolePermissions: {
                        some: { permission: { key: PERMISSIONS.PROJECT_MANAGE } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  async onApplicationBootstrap() {
    await this.ensureStorageRoot();
    await this.reconcilePendingUploads();
    return this.reconcileStorageCleanup();
  }

  async upload(userId: string, customerId: string, file: BufferedUpload) {
    await this.customers.assertCustomerManager(userId, customerId);
    const validated = this.validateFile(file);
    const id = this.createStorageId();
    const storageKey = `customer-contract/${id.slice(0, 2)}/${id}${validated.extension}`;

    const pendingId = await this.storeAttachmentFile({
      userId,
      file,
      validated,
      storageKey,
      createData: {
        resourceType: CUSTOMER_CONTRACT,
        resourceId: customerId,
        customer: { connect: this.currentCustomerManager(userId, customerId) },
      },
      onRelationLost: async () => {
        // Re-evaluate current scope to preserve the 403/404 contract after a
        // concurrent role or membership change. A transient missing relation
        // that no longer reproduces is still fail-closed as not found.
        await this.customers.assertCustomerManager(userId, customerId);
        throw new NotFoundException('客户不存在');
      },
    });

    try {
      return await this.activatePendingUpload(pendingId, userId, customerId, true);
    } catch (error) {
      // The activation outcome may be ambiguous after a database transport error.
      // Keep the durable row and file; startup reconciliation only processes rows
      // that are still PENDING, so a committed ACTIVE row is never deleted here.
      await this.recordStorageCleanupFailure(pendingId, error, 'PENDING');
      throw error;
    }
  }

  /**
   * 通用"落盘 + 发布"管道（客户合同与工作日志附件共用）。
   *
   * 只做存储侧：创建 PENDING 行 → 写临时文件并 fsync → 记录身份 → 硬链接发布 →
   * 标记 published → 清理临时文件。授权与激活由调用方负责，避免把资源语义塞进存储层。
   * 返回 pendingId；失败时按既有补偿逻辑收尾并抛出原始错误。
   */
  async storeAttachmentFile(params: {
    userId: string;
    file: BufferedUpload;
    validated: { originalName: string; extension: string; mime: string };
    storageKey: string;
    createData: Record<string, unknown>;
    onRelationLost: () => Promise<never>;
  }): Promise<string> {
    const { userId, file, validated, storageKey, createData, onRelationLost } = params;
    const finalPath = this.resolveStoragePath(storageKey);
    let pendingId: string | null = null;
    let publication: PendingPublication = 'NONE';
    let directories: DirectoryAnchor[] | null = null;

    try {
      let pending: { id: string };
      try {
        pending = await this.prisma.attachment.create({
          data: {
            storageKey,
            originalName: validated.originalName,
            mimeType: validated.mime,
            sizeBytes: file.buffer.length,
            sha256: createHash('sha256').update(file.buffer).digest('hex'),
            uploadedBy: { connect: { id: userId } },
            ...createData,
            status: 'PENDING',
            storagePublishedAt: null,
          } as never,
          select: { id: true },
        });
      } catch (error) {
        if (this.isFsError(error, 'P2025')) await onRelationLost();
        throw error;
      }
      pendingId = pending.id;

      directories = await this.openEntityDirectoryChain(dirname(finalPath), true);
      if (!directories) throw new BadRequestException('附件目录必须是私有实体目录');
      const parent = directories.at(-1)!;
      const anchoredFinalPath = parent.child(basename(finalPath));
      const anchoredTempPath = parent.child(this.pendingUploadTempName(finalPath));
      const handle = await this.openUploadTemp(anchoredTempPath);
      let primaryError: unknown;
      try {
        await handle.writeFile(file.buffer);
        await handle.sync();
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try {
          await handle.close();
        } catch (closeError) {
          if (primaryError === undefined) throw closeError;
        }
      }
      const tempInfo = await this.safePendingFileInfo(anchoredTempPath, '附件临时存储路径非法');
      if (!tempInfo) throw new Error('附件临时文件丢失');
      const identified = await this.prisma.attachment.updateMany({
        where: { id: pending.id, status: 'PENDING', storageDevice: null, storageInode: null },
        data: { storageDevice: BigInt(tempInfo.dev), storageInode: BigInt(tempInfo.ino) },
      });
      if (identified.count !== 1) throw new Error('附件文件身份状态冲突');
      publication = 'ATTEMPTED';
      try {
        await link(anchoredTempPath, anchoredFinalPath);
      } catch (error) {
        if (this.isFsError(error, 'EEXIST')) {
          const finalInfo = await lstat(anchoredFinalPath).catch(() => null);
          publication =
            finalInfo?.isFile() && !finalInfo.isSymbolicLink() && this.sameFile(tempInfo, finalInfo)
              ? 'LINKED'
              : 'NONE';
        }
        throw error;
      }
      publication = 'LINKED';
      await this.syncStorageDirectory(parent);
      const marked = await this.prisma.attachment.updateMany({
        where: { id: pending.id, status: 'PENDING', storagePublishedAt: null },
        data: { storagePublishedAt: new Date() },
      });
      if (marked.count !== 1) throw new Error('附件发布状态冲突');
      publication = 'DURABLE';
      await this.removeStoragePath(anchoredTempPath);
      await this.syncStorageDirectory(parent);
    } catch (error) {
      if (pendingId) {
        await this.handlePendingUploadFailure(pendingId, finalPath, publication, error);
      }
      throw error;
    } finally {
      if (directories) await this.closeDirectoryHandles(directories);
    }

    return pendingId!;
  }

  async list(userId: string, customerId: string) {
    await this.customers.assertCustomerManager(userId, customerId);
    return this.prisma.attachment.findMany({
      where: {
        resourceType: CUSTOMER_CONTRACT,
        resourceId: customerId,
        customerId,
        customer: { is: this.currentCustomerManager(userId, customerId) },
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: PUBLIC_ATTACHMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  async listWithCapability(userId: string, customerId: string) {
    await this.customers.assertCustomerManager(userId, customerId);
    const items = await this.prisma.attachment.findMany({
      where: {
        resourceType: CUSTOMER_CONTRACT,
        resourceId: customerId,
        customerId,
        customer: { is: this.currentCustomerManager(userId, customerId) },
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: PUBLIC_ATTACHMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return { items, canManage: true };
  }

  async download(userId: string, customerId: string, attachmentId: string) {
    await this.customers.assertCustomerManager(userId, customerId);
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        resourceType: CUSTOMER_CONTRACT,
        resourceId: customerId,
        customerId,
        customer: { is: this.currentCustomerManager(userId, customerId) },
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: {
        id: true,
        storageKey: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        storageDevice: true,
        storageInode: true,
      },
    });
    if (!attachment) throw new NotFoundException('附件不存在');
    if (attachment.storageDevice === null || attachment.storageInode === null) {
      throw new NotFoundException('附件不存在');
    }
    const path = this.resolveStoragePath(attachment.storageKey);
    const directories = await this.openEntityDirectoryChain(dirname(path), false);
    if (!directories) throw new NotFoundException('附件不存在');
    const parent = directories.at(-1)!;
    const anchoredPath = parent.child(basename(path));
    const info = await lstat(anchoredPath).catch(() => null);
    if (!info) {
      await this.closeDirectoryHandles(directories);
      throw new NotFoundException('附件不存在');
    }
    try {
      // 类型与身份用同一次 lstat；ACL 单独查（不重复 stat）。
      this.assertPrivateFile(info);
      await assertPrivateAclOnly(anchoredPath);
    } catch (error) {
      await this.closeDirectoryHandles(directories);
      throw error;
    }
    const handle = await openPrivateFileRead(anchoredPath);
    if (!handle) {
      await this.closeDirectoryHandles(directories);
      throw new NotFoundException('附件不存在');
    }
    try {
      const opened = await handle.stat();
      this.assertPrivateFile(opened);
      if (
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        !this.matchesPersistedIdentity(opened, attachment.storageDevice, attachment.storageInode)
      ) {
        throw new BadRequestException('附件存储路径非法');
      }
    } catch (error) {
      await handle.close();
      await this.closeDirectoryHandles(directories);
      throw error;
    }
    await this.closeDirectoryHandles(directories);
    return {
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      stream: handle.createReadStream({ autoClose: true }),
    };
  }

  /**
   * 通用"验证并打开已发布附件"（授权由调用方完成）：
   * 重新校验目录链、文件元数据/ACL、持久化 dev/ino 身份，然后返回只读流。
   * 客户合同与工作日志附件共用，避免两套身份校验逻辑漂移。
   */
  async openVerifiedAttachmentStream(attachment: {
    id: string;
    storageKey: string;
    storageDevice: bigint | null;
    storageInode: bigint | null;
  }): Promise<{ stream: NodeJS.ReadableStream }> {
    if (attachment.storageDevice === null || attachment.storageInode === null) {
      throw new NotFoundException('附件不存在');
    }
    const path = this.resolveStoragePath(attachment.storageKey);
    const directories = await this.openEntityDirectoryChain(dirname(path), false);
    if (!directories) throw new NotFoundException('附件不存在');
    const parent = directories.at(-1)!;
    const anchoredPath = parent.child(basename(path));
    const info = await lstat(anchoredPath).catch(() => null);
    if (!info) {
      await this.closeDirectoryHandles(directories);
      throw new NotFoundException('附件不存在');
    }
    try {
      this.assertPrivateFile(info);
      await assertPrivateAclOnly(anchoredPath);
    } catch (error) {
      await this.closeDirectoryHandles(directories);
      throw error;
    }
    const handle = await openPrivateFileRead(anchoredPath);
    if (!handle) {
      await this.closeDirectoryHandles(directories);
      throw new NotFoundException('附件不存在');
    }
    try {
      const opened = await handle.stat();
      this.assertPrivateFile(opened);
      if (
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        !this.matchesPersistedIdentity(opened, attachment.storageDevice, attachment.storageInode)
      ) {
        throw new BadRequestException('附件存储路径非法');
      }
    } catch (error) {
      await handle.close();
      await this.closeDirectoryHandles(directories);
      throw error;
    }
    await this.closeDirectoryHandles(directories);
    return { stream: handle.createReadStream({ autoClose: true }) };
  }

  async archive(userId: string, customerId: string, attachmentId: string) {
    await this.customers.assertCustomerManager(userId, customerId);
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        resourceType: CUSTOMER_CONTRACT,
        resourceId: customerId,
        customerId,
        customer: { is: this.currentCustomerManager(userId, customerId) },
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true, storageKey: true, storageDevice: true, storageInode: true },
    });
    if (!attachment) throw new NotFoundException('附件不存在');
    const archived = await this.prisma.attachment.updateMany({
      where: {
        id: attachment.id,
        customerId,
        customer: { is: this.currentCustomerManager(userId, customerId) },
        status: 'ACTIVE',
        deletedAt: null,
      },
      data: {
        status: 'ARCHIVED',
        deletedAt: new Date(),
        storageDeletedAt: null,
        storageCleanupAttempts: 0,
        storageCleanupLastError: null,
      },
    });
    if (archived.count !== 1) throw new NotFoundException('附件不存在');
    try {
      await this.cleanupPublishedFile(this.resolveStoragePath(attachment.storageKey), attachment);
      await this.markStorageDeleted(attachment.id);
    } catch (error) {
      // Logical archival is already durable. Leave storageDeletedAt NULL so a
      // later startup reconciliation can finish physical cleanup idempotently.
      await this.recordStorageCleanupFailure(attachment.id, error);
    }
    return { ok: true };
  }

  async reconcileStorageCleanup(): Promise<{ cleaned: number; failed: number }> {
    await this.ensureStorageRoot();
    const pending = await this.prisma.attachment.findMany({
      where: {
        status: 'ARCHIVED',
        storageDeletedAt: null,
        storageCleanupAttempts: { lt: 3 },
      },
      select: { id: true, storageKey: true, storageDevice: true, storageInode: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    let cleaned = 0;
    let failed = 0;
    for (const attachment of pending) {
      try {
        await this.cleanupPublishedFile(this.resolveStoragePath(attachment.storageKey), attachment);
        const marked = await this.markStorageDeleted(attachment.id);
        if (marked.count === 1) cleaned += 1;
      } catch (error) {
        await this.recordStorageCleanupFailure(attachment.id, error);
        failed += 1;
      }
    }
    return { cleaned, failed };
  }

  private async reconcilePendingUploads(): Promise<void> {
    const pending = await this.prisma.attachment.findMany({
      where: { status: 'PENDING', storageCleanupAttempts: { lt: 3 } },
      select: {
        id: true,
        uploadedById: true,
        customerId: true,
        workLogId: true,
        storageKey: true,
        storagePublishedAt: true,
        storageDevice: true,
        storageInode: true,
      },
      orderBy: { id: 'asc' },
      take: 100,
    });
    for (const attachment of pending) {
      try {
        await this.recoverPendingUpload(attachment);
      } catch (error) {
        await this.recordStorageCleanupFailure(attachment.id, error, 'PENDING');
      }
    }
  }

  private async recoverPendingUpload(attachment: {
    id: string;
    uploadedById: string;
    customerId: string | null;
    workLogId?: string | null;
    storageKey: string;
    storagePublishedAt: Date | null;
    storageDevice: bigint | null;
    storageInode: bigint | null;
  }): Promise<void> {
    const path = this.resolveStoragePath(attachment.storageKey);
    const directories = await this.openEntityDirectoryChain(dirname(path), false);
    if (!directories) {
      throw Object.assign(new Error('附件存储目录缺失'), {
        code: 'PENDING_STORAGE_DIRECTORY_MISSING',
      });
    }
    const parent = directories.at(-1)!;
    const finalPath = parent.child(basename(path));
    const tempPath = parent.child(this.pendingUploadTempName(path));
    try {
      const finalInfo = await this.safePendingFileInfo(finalPath, '附件存储路径非法');
      const tempInfo = await this.safePendingFileInfo(tempPath, '附件临时存储路径非法');
      const hasIdentity = attachment.storageDevice !== null && attachment.storageInode !== null;
      if (!hasIdentity) throw new Error('附件持久化文件身份缺失');
      const ownsFinal =
        finalInfo !== null &&
        this.matchesPersistedIdentity(
          finalInfo,
          attachment.storageDevice!,
          attachment.storageInode!,
        );
      const ownsTemp =
        tempInfo !== null &&
        this.matchesPersistedIdentity(
          tempInfo,
          attachment.storageDevice!,
          attachment.storageInode!,
        );

      if (finalInfo && !ownsFinal) {
        throw new BadRequestException('附件已发布文件身份不匹配');
      }
      if (tempInfo && !ownsTemp) throw new BadRequestException('附件临时文件身份不匹配');

      if (!attachment.storagePublishedAt && !finalInfo) {
        // A matching temp file is the only durable recovery evidence. Never
        // publish it without a marker, but retain both it and the PENDING row.
        throw Object.assign(new Error('附件发布标记缺失'), {
          code: 'PENDING_PUBLICATION_MARKER_MISSING',
        });
      }

      if (!attachment.storagePublishedAt) throw new Error('附件发布标记缺失');
      if (!finalInfo) throw new Error('附件已标记发布文件缺失');
      if (!ownsFinal) throw new Error('附件发布归属无法安全确认');

      // Re-fsync the final directory even for rows created by an older build:
      // the publication marker is not sufficient crash evidence on its own.
      await this.syncStorageDirectory(parent);
      if (tempInfo) {
        await this.removeStoragePath(tempPath, { force: true });
        await this.syncStorageDirectory(parent);
      }
      if (attachment.workLogId) {
        // 工作日志附件：作者仍有效且日志仍是 DRAFT 才激活，否则保留 PENDING 证据。
        const activated = await this.prisma.attachment.updateMany({
          where: {
            id: attachment.id,
            workLogId: attachment.workLogId,
            status: 'PENDING',
            storagePublishedAt: { not: null },
            workLog: {
              is: {
                authorId: attachment.uploadedById,
                status: 'DRAFT',
                deletedAt: null,
                author: { status: 'ACTIVE', deletedAt: null },
              },
            },
          },
          // 与客户合同路径一致：激活成功要清掉重试计数与历史错误码。
          data: { status: 'ACTIVE', storageCleanupAttempts: 0, storageCleanupLastError: null },
        });
        if (activated.count !== 1) {
          throw Object.assign(new Error('附件工作日志授权关系缺失'), {
            code: 'PENDING_AUTHORIZATION_MISSING',
          });
        }
        return;
      }
      if (!attachment.customerId) {
        throw Object.assign(new Error('附件客户授权关系缺失'), {
          code: 'PENDING_AUTHORIZATION_MISSING',
        });
      }
      await this.activatePendingUpload(
        attachment.id,
        attachment.uploadedById,
        attachment.customerId,
        false,
      );
    } finally {
      await this.closeDirectoryHandles(directories);
    }
  }

  private async handlePendingUploadFailure(
    attachmentId: string,
    finalPath: string,
    publication: PendingPublication,
    error: unknown,
  ): Promise<void> {
    if (publication !== 'NONE') {
      // Once the hard-link exists, retain the durable pending row and every
      // ownership proof. Reconciliation can finish publication or activation.
      await this.recordStorageCleanupFailure(attachmentId, error, 'PENDING');
      return;
    }
    try {
      await this.cleanupUnpublishedTemp(finalPath);
    } catch (cleanupError) {
      await this.recordStorageCleanupFailure(attachmentId, cleanupError, 'PENDING');
      return;
    }
    try {
      await this.deletePendingUpload(attachmentId);
    } catch (cleanupStateError) {
      this.logger.error('pending attachment cleanup state could not be removed', {
        attachmentId,
        errorCode: this.storageCleanupErrorCode(cleanupStateError),
        originalErrorCode: this.storageCleanupErrorCode(error),
      });
    }
  }

  private async activatePendingUpload(
    attachmentId: string,
    uploadedById: string,
    customerId: string,
    classifyAuthorization: boolean,
  ) {
    const activated = await this.prisma.attachment.updateMany({
      where: {
        id: attachmentId,
        uploadedById,
        customerId,
        customer: { is: this.currentCustomerManager(uploadedById, customerId) },
        status: 'PENDING',
        storagePublishedAt: { not: null },
      },
      data: { status: 'ACTIVE', storageCleanupAttempts: 0, storageCleanupLastError: null },
    });
    if (activated.count !== 1) {
      if (classifyAuthorization) {
        await this.customers.assertCustomerManager(uploadedById, customerId);
      }
      throw Object.assign(new Error('附件激活授权或状态冲突'), {
        code: 'PENDING_AUTHORIZATION_OR_STATE_CONFLICT',
      });
    }
    return this.prisma.attachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: PUBLIC_ATTACHMENT_SELECT,
    });
  }

  private deletePendingUpload(attachmentId: string) {
    return this.prisma.attachment.deleteMany({
      where: { id: attachmentId, status: 'PENDING' },
    });
  }

  private markStorageDeleted(attachmentId: string) {
    return this.prisma.attachment.updateMany({
      where: { id: attachmentId, status: 'ARCHIVED', storageDeletedAt: null },
      data: { storageDeletedAt: new Date(), storageCleanupLastError: null },
    });
  }

  private async recordStorageCleanupFailure(
    attachmentId: string,
    error: unknown,
    status: 'PENDING' | 'ARCHIVED' = 'ARCHIVED',
  ): Promise<void> {
    const errorCode = this.storageCleanupErrorCode(error);
    try {
      await this.prisma.attachment.updateMany({
        where: {
          id: attachmentId,
          status,
          ...(status === 'ARCHIVED' ? { storageDeletedAt: null } : {}),
          storageCleanupAttempts: { lt: 3 },
        },
        data: {
          storageCleanupAttempts: { increment: 1 },
          storageCleanupLastError: errorCode,
        },
      });
    } catch {
      this.logger.error('attachment storage cleanup retry state could not be persisted', {
        attachmentId,
        errorCode,
      });
      return;
    }
    this.logger.warn('attachment storage cleanup deferred', { attachmentId, errorCode });
  }

  private storageCleanupErrorCode(error: unknown): string {
    if (error instanceof BadRequestException) return 'INVALID_STORAGE_PATH';
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z0-9_]{1,64}$/.test(error.code)
    ) {
      return error.code;
    }
    return 'UNKNOWN_STORAGE_ERROR';
  }

  validateFile(file: BufferedUpload) {
    if (!file || !Buffer.isBuffer(file.buffer)) throw new BadRequestException('缺少附件');
    if (file.buffer.length === 0 || file.size !== file.buffer.length) {
      throw new BadRequestException('附件大小非法');
    }
    if (file.buffer.length > MAX_ATTACHMENT_BYTES)
      throw new BadRequestException('附件不能超过 20 MiB');
    const originalName = basename(file.originalname.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 255);
    if (!originalName) throw new BadRequestException('附件名非法');
    const extension = extname(originalName).toLowerCase() as keyof typeof TYPES;
    const type = TYPES[extension];
    if (!type || file.mimetype !== type.mime || !type.magic(file.buffer)) {
      throw new BadRequestException('附件扩展名、MIME 与文件内容必须一致');
    }
    return { originalName, extension, mime: type.mime };
  }

  private resolveStoragePath(storageKey: string): string {
    // 存储键按资源类型分区：客户合同 customer-contract/，工作日志附件 work-log/。
    if (
      !/^(?:customer-contract|work-log)\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|png|jpe?g|docx|xlsx)$/.test(
        storageKey,
      )
    ) {
      throw new BadRequestException('附件存储键非法');
    }
    const path = resolve(this.root, storageKey);
    if (!path.startsWith(`${this.root}${sep}`)) throw new BadRequestException('附件路径非法');
    return path;
  }

  private async ensureStorageRoot(): Promise<void> {
    await mkdir(this.root, { mode: 0o700 }).catch((error: unknown) => {
      if (!this.isFsError(error, 'EEXIST')) throw error;
    });
    await this.assertEntityDirectory(this.root);
  }

  private async openEntityDirectoryChain(
    directory: string,
    create: boolean,
  ): Promise<DirectoryAnchor[] | null> {
    await this.ensureStorageRoot();
    const components = this.relativeDirectoryComponents(directory);
    const anchors: DirectoryAnchor[] = [];
    try {
      const rootInfo = await lstat(this.root);
      this.assertPrivateDirectory(rootInfo);
      const rootAnchor = await openPrivateDirectory(this.root);
      const openedRoot = await rootAnchor.stat();
      if (openedRoot.dev !== rootInfo.dev || openedRoot.ino !== rootInfo.ino) {
        await rootAnchor.close();
        throw new BadRequestException('附件目录必须是私有实体目录');
      }
      anchors.push(rootAnchor);
      for (const component of components) {
        const parent = anchors.at(-1)!;
        const child = parent.child(component);
        if (create) {
          await mkdir(child, { mode: 0o700 }).catch((error: unknown) => {
            if (!this.isFsError(error, 'EEXIST')) throw error;
          });
        }
        const info = await lstat(child).catch((error: unknown) => {
          if (!create && this.isFsError(error, 'ENOENT')) return null;
          throw error;
        });
        if (!info) {
          await this.closeDirectoryHandles(anchors);
          return null;
        }
        this.assertPrivateDirectory(info);
        const anchor = await openPrivateDirectory(child);
        const opened = await anchor.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino) {
          await anchor.close();
          throw new BadRequestException('附件目录必须是私有实体目录');
        }
        anchors.push(anchor);
      }
      return anchors;
    } catch (error) {
      await this.closeDirectoryHandles(anchors);
      throw error;
    }
  }

  private async closeDirectoryHandles(anchors: DirectoryAnchor[]): Promise<void> {
    await Promise.all(anchors.toReversed().map((anchor) => anchor.close().catch(() => undefined)));
  }

  private relativeDirectoryComponents(directory: string): string[] {
    const path = relative(this.root, directory);
    if (!path || path === '.') return [];
    const components = path.split(sep);
    if (path.startsWith(`..${sep}`) || path === '..' || components.some((part) => !part)) {
      throw new BadRequestException('附件存储路径非法');
    }
    return components;
  }

  private async assertEntityDirectory(directory: string): Promise<void> {
    try {
      await assertPrivateDirectoryPath(directory);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // 原始错误（含绝对路径/errno）只进服务端日志；对外统一静态文案，避免向已登录用户
      // 泄漏附件根路径。storageCleanupErrorCode 仍保留在记录链路里。
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`附件目录校验失败：${detail.slice(0, 200)}`);
      throw new BadRequestException('附件目录必须是私有实体目录');
    }
  }

  private assertPrivateDirectory(info: Stats): void {
    assertPrivateDirectoryMetadata(info);
  }

  private assertPrivateFile(info: Stats): void {
    assertPrivateFileMetadata(info);
  }

  private isFsError(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  }

  private pendingUploadTempName(path: string): string {
    return `.${basename(path)}.pending`;
  }

  private async safePendingFileInfo(path: string, message: string): Promise<Stats | null> {
    const info = await lstat(path).catch((error: unknown) => {
      if (this.isFsError(error, 'ENOENT')) return null;
      throw error;
    });
    if (info) {
      try {
        // 类型/身份用同一次 stat 判定；Windows 再单独校验 ACL（不重复 stat）。
        assertPrivateFileMetadata(info);
        await assertPrivateAclOnly(path);
      } catch {
        throw new BadRequestException(message);
      }
    }
    return info;
  }

  private sameFile(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private matchesPersistedIdentity(info: Stats, device: bigint, inode: bigint): boolean {
    return BigInt(info.dev) === device && BigInt(info.ino) === inode;
  }

  private async cleanupUnpublishedTemp(path: string): Promise<void> {
    const directories = await this.openEntityDirectoryChain(dirname(path), false);
    if (!directories) return;
    const parent = directories.at(-1)!;
    const anchoredTempPath = parent.child(this.pendingUploadTempName(path));
    try {
      const info = await this.safePendingFileInfo(anchoredTempPath, '附件临时存储路径非法');
      if (info) await this.removeStoragePath(anchoredTempPath, { force: true });
    } finally {
      await this.closeDirectoryHandles(directories);
    }
  }

  private cleanupQuarantineName(path: string, attachmentId: string): string {
    const suffix = createHash('sha256').update(attachmentId).digest('hex').slice(0, 32);
    return `.${basename(path)}.cleanup-${suffix}`;
  }

  private async cleanupPublishedFile(
    path: string,
    attachment: { id: string; storageDevice: bigint | null; storageInode: bigint | null },
  ): Promise<void> {
    if (attachment.storageDevice === null || attachment.storageInode === null) {
      throw new BadRequestException('附件持久化文件身份缺失');
    }
    const directories = await this.openEntityDirectoryChain(dirname(path), false);
    if (!directories) return;
    const shard = directories.at(-1)!;
    const contract = directories.at(-2)!;
    const root = directories[0]!;
    const anchoredPath = shard.child(basename(path));
    const quarantinePath = shard.child(this.cleanupQuarantineName(path, attachment.id));
    try {
      const quarantineInfo = await this.safePendingFileInfo(quarantinePath, '附件清理隔离路径非法');
      if (quarantineInfo) {
        if (
          !this.matchesPersistedIdentity(
            quarantineInfo,
            attachment.storageDevice,
            attachment.storageInode,
          )
        ) {
          throw new BadRequestException('附件清理隔离文件身份不匹配');
        }
        await this.removeStoragePath(quarantinePath);
      }

      const info = await this.safePendingFileInfo(anchoredPath, '附件存储路径非法');
      if (info) {
        if (
          !this.matchesPersistedIdentity(info, attachment.storageDevice, attachment.storageInode)
        ) {
          throw new BadRequestException('附件已发布文件身份不匹配');
        }
        await this.moveStoragePathNoReplace(anchoredPath, quarantinePath, shard.fd);
        const sourceAfterMove = await this.safePendingFileInfo(anchoredPath, '附件存储路径非法');
        if (sourceAfterMove) {
          // GNU mv --no-clobber exits successfully when a destination appeared
          // concurrently. A successful exit is therefore not proof that the
          // source directory entry was removed.
          throw new BadRequestException('附件清理移动未移除原路径');
        }
        const moved = await this.safePendingFileInfo(quarantinePath, '附件清理隔离路径非法');
        if (
          !moved ||
          !this.matchesPersistedIdentity(moved, attachment.storageDevice, attachment.storageInode)
        ) {
          if (moved) {
            try {
              await link(quarantinePath, anchoredPath);
              await this.removeStoragePath(quarantinePath);
            } catch {
              // Preserve an ambiguous quarantine entry for manual recovery.
            }
          }
          throw new BadRequestException('附件清理移动后身份不匹配');
        }
        await this.removeStoragePath(quarantinePath);
      }
      await rmdir(contract.child(basename(dirname(path)))).catch(() => undefined);
      await rmdir(root.child(basename(dirname(dirname(path))))).catch(() => undefined);
    } finally {
      await this.closeDirectoryHandles(directories);
    }
  }
}
