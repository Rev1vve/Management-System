'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { api } from '@/lib/api';

/**
 * 职责首页。
 *
 * 每条数据都由服务端按调用者的作用域返回：`scope=OWN` 表示只看本人，
 * `PROJECTS` 表示授权项目汇总。首页不猜测角色，也不把聚合当成明细。
 */
export function DashboardView() {
  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => api.reportSummary({}),
    retry: false,
  });
  const myLogs = useQuery({
    queryKey: ['dashboard', 'my-work-logs'],
    queryFn: () => api.listMyWorkLogs({ page: 1, pageSize: 5 }),
    retry: false,
  });
  const pending = useQuery({
    queryKey: ['dashboard', 'approvals'],
    queryFn: () => api.listApprovals({ page: 1, pageSize: 3 }),
    retry: false,
  });
  const notifications = useQuery({
    queryKey: ['dashboard', 'notifications'],
    queryFn: () => api.listNotifications({ page: 1, pageSize: 3 }),
    retry: false,
  });

  const ownScope = summary.data?.scope === 'OWN';
  const returnRate = summary.data ? Math.round(summary.data.approvals.returnRate * 1000) / 10 : 0;

  return (
    <AppShell>
      <header className="mb-6">
        <p className="text-sm text-muted">职责首页</p>
        <h1 className="text-2xl font-semibold text-ink">工作台</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          汇总最近 7 个业务日的数据；审批与通知是实时待办。
        </p>
      </header>

      {summary.isPending ? <LoadingState title="正在加载工作台" /> : null}
      {summary.isError ? (
        <ErrorState
          {...errorCopy(summary.error, '工作台')}
          action={
            <Button type="button" variant="secondary" onClick={() => summary.refetch()}>
              重新加载
            </Button>
          }
        />
      ) : null}

      {summary.data ? (
        <>
          <p className="text-sm text-muted">
            {summary.data.range.from} 至 {summary.data.range.to} ·{' '}
            {ownScope ? '仅本人数据' : '授权项目汇总'} · 范围内项目 {summary.data.projects.inScope}{' '}
            个
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label={ownScope ? '我的工时' : '团队工时'}
              value={`${summary.data.hours.total} h`}
              href="/reports"
            />
            <Metric
              label="待办审批"
              value={pending.data ? String(pending.data.total) : '—'}
              href="/approvals"
            />
            <Metric
              label="未读通知"
              value={notifications.data ? String(notifications.data.unread) : '—'}
              href="/notifications"
            />
            <Metric label="退回率" value={`${returnRate}%`} href="/reports" />
          </div>
          {summary.data.hours.truncated ? (
            <p className="mt-2 text-sm text-danger" role="alert">
              工时统计达到单次上限（{summary.data.hours.limit} 条），数字可能偏小。
            </p>
          ) : null}
        </>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <h2 className="font-semibold text-ink">我的待办审批</h2>
            <Button asChild variant="secondary">
              <Link href="/approvals">全部</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {pending.isPending ? <LoadingState title="正在加载待办" /> : null}
            {pending.isError ? (
              <ErrorState
                {...errorCopy(pending.error, '待办审批')}
                action={
                  <Button type="button" variant="secondary" onClick={() => pending.refetch()}>
                    重新加载
                  </Button>
                }
              />
            ) : null}
            {pending.data && pending.data.items.length === 0 ? (
              <EmptyState title="没有待办审批" description="分配给你的审批会出现在这里。" />
            ) : null}
            {pending.data && pending.data.items.length > 0 ? (
              <ul className="space-y-3">
                {pending.data.items.map((item) => (
                  <li key={item.id} className="border-b border-border pb-3 last:border-0">
                    <Link
                      className="font-mono text-xs underline"
                      href={`/worklogs/${item.workLogVersion.workLog.id}`}
                    >
                      {item.workLogVersion.workLog.number}
                    </Link>
                    <p className="mt-1 text-sm text-muted">
                      {item.workLogVersion.workLog.author.name} ·{' '}
                      {item.workLogVersion.workLog.project?.name ?? '未关联项目'} ·{' '}
                      {item.submittedAt.slice(0, 10)}
                    </p>
                    {item.canDecide ? null : (
                      <p className="mt-1 text-xs text-muted">该请求绑定的版本已不是当前版本</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <h2 className="font-semibold text-ink">我的工作日志</h2>
            <Button asChild variant="secondary">
              <Link href="/worklogs">全部</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {myLogs.isPending ? <LoadingState title="正在加载工作日志" /> : null}
            {myLogs.isError ? (
              <ErrorState
                {...errorCopy(myLogs.error, '工作日志')}
                action={
                  <Button type="button" variant="secondary" onClick={() => myLogs.refetch()}>
                    重新加载
                  </Button>
                }
              />
            ) : null}
            {myLogs.data && myLogs.data.items.length === 0 ? (
              <EmptyState
                title="还没有工作日志"
                description="记录第一份草稿后，这里会显示最近的内容。"
              />
            ) : null}
            {myLogs.data && myLogs.data.items.length > 0 ? (
              <ul className="space-y-3">
                {myLogs.data.items.map((item) => (
                  <li key={item.id} className="border-b border-border pb-3 last:border-0">
                    <Link className="font-mono text-xs underline" href={`/worklogs/${item.id}`}>
                      {item.number}
                    </Link>
                    <p className="mt-1 text-sm text-muted">
                      {item.currentVersion?.workDate.slice(0, 10) ?? '—'} ·{' '}
                      {item.currentVersion?.hours ?? '—'} h · {statusLabel(item.status)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button asChild className="mt-4">
              <Link href="/worklogs/new">记录工作日志</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <h2 className="font-semibold text-ink">最新通知</h2>
          <Button asChild variant="secondary">
            <Link href="/notifications">全部</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {notifications.isPending ? <LoadingState title="正在加载通知" /> : null}
          {notifications.isError ? (
            <ErrorState
              {...errorCopy(notifications.error, '通知')}
              action={
                <Button type="button" variant="secondary" onClick={() => notifications.refetch()}>
                  重新加载
                </Button>
              }
            />
          ) : null}
          {notifications.data && notifications.data.items.length === 0 ? (
            <EmptyState title="没有通知" description="审批结果等事件会出现在这里。" />
          ) : null}
          {notifications.data && notifications.data.items.length > 0 ? (
            <ul className="space-y-3">
              {notifications.data.items.map((item) => (
                <li key={item.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-medium text-ink">{item.title}</p>
                  <p className="text-xs text-muted">
                    {item.status === 'UNREAD' ? '未读' : '已读'} · {item.createdAt.slice(0, 10)}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </AppShell>
  );
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  APPROVED: '已通过',
  RETURNED: '退回修改',
  REJECTED: '已拒绝',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function Metric({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted">{label}</p>
        <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
        <Link
          className="mt-2 inline-block text-xs underline"
          href={href}
          aria-label={`查看${label}`}
        >
          查看
        </Link>
      </CardContent>
    </Card>
  );
}
