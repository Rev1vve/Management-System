import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseListQuery } from './business-query';

const options = {
  statuses: ['ACTIVE', 'ARCHIVED'] as const,
  sortFields: ['name', 'updatedAt'] as const,
};

describe('parseListQuery', () => {
  it('applies safe pagination and sorting defaults', () => {
    expect(parseListQuery({}, options)).toEqual({
      page: 1,
      pageSize: 20,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
  });

  it('rejects pageSize above the shared maximum', () => {
    expect(() => parseListQuery({ pageSize: '101' }, options)).toThrow(BadRequestException);
  });

  it('rejects unknown query fields instead of silently accepting them', () => {
    expect(() => parseListQuery({ hidden: 'value' }, options)).toThrow(BadRequestException);
  });

  it('accepts only explicitly allowed status and sort values', () => {
    expect(() => parseListQuery({ status: 'SUSPENDED' }, options)).toThrow(BadRequestException);
    expect(() => parseListQuery({ sortBy: 'deletedAt' }, options)).toThrow(BadRequestException);
    expect(() => parseListQuery({ sortOrder: 'sideways' }, options)).toThrow(BadRequestException);
  });

  it('normalizes an allowed search, status, sort and pagination query', () => {
    expect(
      parseListQuery(
        {
          page: '2',
          pageSize: '10',
          search: '  alpha  ',
          status: 'ACTIVE',
          sortBy: 'name',
          sortOrder: 'asc',
        },
        options,
      ),
    ).toEqual({
      page: 2,
      pageSize: 10,
      search: 'alpha',
      status: 'ACTIVE',
      sortBy: 'name',
      sortOrder: 'asc',
    });
  });
});
