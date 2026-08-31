import { BadRequestException } from '@nestjs/common';

export const MAX_PAGE_SIZE = 100;

export interface ListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}

export interface ListQueryOptions {
  statuses: readonly string[];
  sortFields: readonly string[];
}

const ALLOWED_KEYS = new Set(['page', 'pageSize', 'search', 'status', 'sortBy', 'sortOrder']);

function scalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${name} 必须是单值字符串`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const raw = scalar(value, name)!;
  if (!/^\d+$/.test(raw)) throw new BadRequestException(`${name} 必须是正整数`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new BadRequestException(`${name} 必须是正整数`);
  }
  return result;
}

export function parseListQuery(raw: Record<string, unknown>, options: ListQueryOptions): ListQuery {
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) throw new BadRequestException(`未知查询字段: ${unknown.join(', ')}`);

  const page = positiveInteger(raw.page, 1, 'page');
  const pageSize = positiveInteger(raw.pageSize, 20, 'pageSize');
  if (pageSize > MAX_PAGE_SIZE) throw new BadRequestException(`pageSize 不能超过 ${MAX_PAGE_SIZE}`);

  const searchValue = scalar(raw.search, 'search')?.trim();
  if (searchValue !== undefined && (searchValue.length === 0 || searchValue.length > 100)) {
    throw new BadRequestException('search 长度必须为 1-100');
  }

  const status = scalar(raw.status, 'status');
  if (status !== undefined && !options.statuses.includes(status)) {
    throw new BadRequestException('非法 status');
  }

  const sortBy = scalar(raw.sortBy, 'sortBy') ?? 'updatedAt';
  if (!options.sortFields.includes(sortBy)) throw new BadRequestException('非法 sortBy');
  const sortOrder = scalar(raw.sortOrder, 'sortOrder') ?? 'desc';
  if (sortOrder !== 'asc' && sortOrder !== 'desc') throw new BadRequestException('非法 sortOrder');

  return {
    page,
    pageSize,
    ...(searchValue ? { search: searchValue } : {}),
    ...(status ? { status } : {}),
    sortBy,
    sortOrder,
  };
}

export function assertAllowedFields(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('请求体必须是对象');
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new BadRequestException(`未知字段: ${unknown.join(', ')}`);
}

export function requireString(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string') throw new BadRequestException(`${name} 必须是字符串`);
  const result = value.trim();
  if (!result || result.length > max) throw new BadRequestException(`${name} 长度非法`);
  return result;
}

export function optionalString(
  value: unknown,
  name: string,
  max = 2000,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${name} 必须是字符串或 null`);
  const result = value.trim();
  if (result.length > max) throw new BadRequestException(`${name} 过长`);
  return result || null;
}

export function requireVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new BadRequestException('version 必须是正整数');
  }
  return value as number;
}

export function optionalDate(value: unknown, name: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${name} 必须是 YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${name} 日期非法`);
  }
  return date;
}
