'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';

const PAGE_SIZE = 20;

/**
 * 审计时间按服务端返回的业务时区显示（不能用 UTC 配 Melbourne 标签）。
 * 用 YYYY-MM-DD HH:mm:ss 明确格式，避免 en-AU 的 dd/mm 与中文界面混读。
 */
function businessTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

/** 审计查询：只读。没有编辑/删除入口——审计行只能由系统追加。 */
export default function AdminAuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const rangeInvalid = Boolean(from && to && from > to);

  const query = useQuery({
    queryKey: ['admin', 'audit', page, action, actorId, from, to],
    queryFn: () =>
      api.listAudit({
        page,
        pageSize: PAGE_SIZE,
        action: action || undefined,
        actorId: actorId || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    retry: false,
    enabled: !rangeInvalid,
  });

  const auditError = (error: unknown) =>
    error instanceof ApiError && error.status === 400
      ? { title: '查询条件不合法', description: error.message }
      : errorCopy(error, '审计记录');

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">管理中心</p>
          <h1 className="text-2xl font-semibold text-ink">审计查询</h1>
          <p className="mt-1 text-sm text-muted">
            只读记录：谁在什么时候做了什么。系统不会修改或删除审计行。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-ink">
            动作
            <Input
              className="mt-1"
              placeholder="例如 user.roles.changed"
              value={action}
              onChange={(event) => {
                setPage(1);
                setAction(event.target.value);
              }}
            />
          </label>
          <label className="text-sm font-medium text-ink">
            操作人 ID
            <Input
              className="mt-1"
              value={actorId}
              onChange={(event) => {
                setPage(1);
                setActorId(event.target.value);
              }}
            />
          </label>
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
      {!rangeInvalid && query.isPending ? <LoadingState title="正在加载审计记录" /> : null}
      {query.isError ? (
        <div role="alert">
          <ErrorState
            {...auditError(query.error)}
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
          title="没有匹配的审计记录"
          description={
            action || actorId || from || to
              ? '当前筛选条件下没有记录，调整条件再试。'
              : '系统还没有写入任何审计记录。'
          }
        />
      ) : null}

      {!rangeInvalid && query.data && query.data.items.length > 0 ? (
        <Card className="mt-6">
          <CardContent>
            <p className="text-sm text-muted">
              时区 {query.data.timezone} · 共 {query.data.total} 条
            </p>
            <TableContainer>
              <Table>
                <thead>
                  <tr>
                    <TableHead>时间</TableHead>
                    <TableHead>操作人</TableHead>
                    <TableHead>动作</TableHead>
                    <TableHead>对象</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>摘要</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <TableCell className="whitespace-nowrap text-xs">
                        {businessTime(row.createdAt, query.data!.timezone)}
                      </TableCell>
                      <TableCell>{row.actor?.name ?? row.actorId ?? '系统'}</TableCell>
                      <TableCell className="font-mono text-xs">{row.action}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.resourceType}
                        {row.resourceId ? `:${row.resourceId}` : ''}
                      </TableCell>
                      <TableCell>{row.result}</TableCell>
                      <TableCell>{row.summary ?? '—'}</TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableContainer>
            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-sm text-muted">第 {query.data.page} 页</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={page * PAGE_SIZE >= query.data.total}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
