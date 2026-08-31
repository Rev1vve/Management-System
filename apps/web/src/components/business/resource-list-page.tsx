'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, ReactNode, useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { ApiError, PaginatedResponse } from '@/lib/api';

export function errorCopy(error: unknown, noun: string, action = '查看') {
  if (error instanceof ApiError) {
    if (error.status === 401) return { title: '登录已过期', description: '请重新登录后再试。' };
    if (error.status === 403)
      return { title: `你无权${action}这些${noun}`, description: '访问范围由服务端授权决定。' };
    if (error.status === 404)
      return { title: `${noun}不存在或已被删除`, description: '请返回列表并刷新。' };
    if (error.status === 409)
      return { title: '数据已发生冲突', description: '请刷新后重试，避免覆盖他人的修改。' };
  }
  return { title: `无法加载${noun}`, description: '请稍后重试。' };
}

interface Column<T> {
  label: string;
  render: (item: T) => ReactNode;
  className?: string;
}
interface Props<T extends { id: string }> {
  resource: string;
  title: string;
  description: string;
  badge: string;
  noun: string;
  statuses: Array<{ value: string; label: string }>;
  query: (value: {
    page: number;
    pageSize: number;
    search: string;
    status: string;
  }) => Promise<PaginatedResponse<T>>;
  columns: Column<T>[];
  actions?: (data: PaginatedResponse<T>) => ReactNode;
}

export function ResourceListPage<T extends { id: string }>({
  resource,
  title,
  description,
  badge,
  noun,
  statuses,
  query,
  columns,
  actions,
}: Props<T>) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawPage = Number(searchParams.get('page') ?? 1);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const search = searchParams.get('search') ?? '';
  const status = searchParams.get('status') ?? '';
  const [draftSearch, setDraftSearch] = useState(search);
  const result = useQuery({
    queryKey: [resource, { page, pageSize: 20, search, status }],
    queryFn: () => query({ page, pageSize: 20, search, status }),
  });

  function navigate(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.push(`${pathname}?${next.toString()}`);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    navigate({ search: draftSearch.trim(), page: '1' });
  }

  return (
    <AppShell>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Badge variant="neutral">{badge}</Badge>
          <h1 className="mt-3 text-2xl font-bold text-[var(--color-navy)]">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">{description}</p>
        </div>
        {result.data && actions ? actions(result.data) : null}
      </header>
      <Card>
        <CardContent className="p-0">
          <form
            onSubmit={submit}
            className="flex flex-col gap-3 border-b border-[var(--color-border)] p-4 sm:flex-row"
            aria-label={`${noun}筛选`}
          >
            <Input
              type="search"
              aria-label={`搜索${noun}`}
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              placeholder={`搜索${noun}`}
              className="sm:max-w-sm"
            />
            <select
              aria-label={`${noun}状态`}
              value={status}
              onChange={(e) => navigate({ status: e.target.value, page: '1' })}
              className="h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3"
            >
              <option value="">全部状态</option>
              {statuses.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <Button type="submit">搜索</Button>
          </form>
          {result.isLoading ? <LoadingState title={`正在加载${noun}`} /> : null}
          {result.isError ? (
            <ErrorState {...errorCopy(result.error, noun)} className="border-0" />
          ) : null}
          {result.data?.items.length === 0 ? (
            <EmptyState
              title={`暂时没有可查看的${noun}`}
              description={`服务端返回的${noun}会显示在这里。`}
              className="border-0 bg-white py-10"
            />
          ) : null}
          {result.data && result.data.items.length > 0 ? (
            <>
              <TableContainer>
                <Table aria-label={`${noun}列表`}>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <TableHead key={column.label}>{column.label}</TableHead>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.items.map((item) => (
                      <tr key={item.id}>
                        {columns.map((column) => (
                          <TableCell key={column.label} className={column.className}>
                            {column.label === columns[0]?.label ? (
                              <Link
                                className="flex min-h-11 items-center font-semibold text-[var(--color-navy)] underline-offset-4 hover:underline"
                                href={`/${resource}/${encodeURIComponent(item.id)}`}
                              >
                                {column.render(item)}
                              </Link>
                            ) : (
                              column.render(item)
                            )}
                          </TableCell>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableContainer>
              <nav
                aria-label={`${noun}分页`}
                className="flex items-center justify-between gap-3 p-4"
              >
                <Button
                  type="button"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => navigate({ page: String(page - 1) })}
                >
                  上一页
                </Button>
                <span className="text-sm">
                  第 {page} / {Math.max(1, result.data.totalPages)} 页
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={page >= result.data.totalPages}
                  onClick={() => navigate({ page: String(page + 1) })}
                >
                  下一页
                </Button>
              </nav>
            </>
          ) : null}
        </CardContent>
      </Card>
    </AppShell>
  );
}
