'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  ON_HOLD: '暂停',
  COMPLETED: '已完成',
  ARCHIVED: '已归档',
};

/**
 * 我管理的项目：只包含调用者以项目经理身份参与的项目（服务端判定）。
 * 页面不推断"我有 project:manage 所以能看全部"。
 */
export default function ManagedProjectsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = { from: from || undefined, to: to || undefined };
  const rangeInvalid = Boolean(from && to && from > to);

  const query = useQuery({
    queryKey: ['reports', 'managed-projects', range],
    queryFn: () => api.reportManagedProjects(range),
    retry: false,
    enabled: !rangeInvalid,
  });

  const reportError = (error: unknown) =>
    error instanceof ApiError && error.status === 400
      ? { title: '日期区间不合法', description: error.message }
      : errorCopy(error, '所辖项目');

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">项目经理视角</p>
          <h1 className="text-2xl font-semibold text-ink">我管理的项目</h1>
          <p className="mt-1 text-sm text-muted">
            只列出你以项目经理身份参与的项目；工时只统计已提交的当前版本。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-ink">
            起始日期
            <Input
              type="date"
              className="mt-1"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="text-sm font-medium text-ink">
            结束日期
            <Input
              type="date"
              className="mt-1"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
      </div>

      {rangeInvalid ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          起始日期不能晚于结束日期。
        </p>
      ) : null}
      {!rangeInvalid && query.isPending ? <LoadingState title="正在加载所辖项目" /> : null}
      {query.isError ? (
        <div role="alert">
          <ErrorState
            {...reportError(query.error)}
            action={
              query.error instanceof ApiError && query.error.status === 400 ? undefined : (
                <Button type="button" variant="secondary" onClick={() => query.refetch()}>
                  重新加载
                </Button>
              )
            }
          />
        </div>
      ) : null}

      {query.data && query.data.items.length === 0 ? (
        <EmptyState
          title="没有你管理的项目"
          description="当你被设为某个项目的项目经理后，这里会显示该项目的进度与工时。"
        />
      ) : null}
      {query.data && query.data.items.length === 0 && query.data.projectsManaged === 0
        ? null
        : null}

      {query.data && query.data.items.length > 0 ? (
        <Card className="mt-6">
          <CardContent>
            <p className="text-sm text-muted">
              {query.data.range.from} 至 {query.data.range.to}
            </p>
            <TableContainer>
              <Table>
                <thead>
                  <tr>
                    <TableHead>项目</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>完成进度</TableHead>
                    <TableHead>工时</TableHead>
                    <TableHead>通过</TableHead>
                    <TableHead>退回</TableHead>
                    <TableHead>退回率</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((row) => (
                    <tr key={row.projectId} className="border-t border-border">
                      <TableCell>
                        <Link className="underline" href={`/projects/${row.projectId}`}>
                          <span className="font-mono text-xs">{row.number}</span> {row.name}
                        </Link>
                      </TableCell>
                      <TableCell>{STATUS_LABELS[row.status] ?? row.status}</TableCell>
                      <TableCell>{row.completionPercent}%</TableCell>
                      <TableCell>{row.hours} h</TableCell>
                      <TableCell>{row.approved}</TableCell>
                      <TableCell>{row.returned}</TableCell>
                      <TableCell>{Math.round(row.returnRate * 1000) / 10}%</TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableContainer>
            {query.data.truncated ? (
              <p className="mt-2 text-sm text-danger" role="alert">
                数据量超过单次上限（{query.data.limit} 条），统计可能不完整；请缩短日期区间。
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
