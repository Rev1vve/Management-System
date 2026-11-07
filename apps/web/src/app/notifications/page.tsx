'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';

const PAGE_SIZE = 20;

/**
 * 通知中心：只显示本人的通知（服务端按收件人过滤）。
 * 未读数量来自服务端，不靠前端猜；标记已读对已读通知幂等。
 */
export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const query = useQuery({
    queryKey: ['notifications', page, unreadOnly],
    queryFn: () => api.listNotifications({ page, pageSize: PAGE_SIZE, unreadOnly }),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">消息</p>
          <h1 className="text-2xl font-semibold text-ink">通知中心</h1>
          <p className="mt-1 text-sm text-muted">
            审批结果等事件会写在这里；标记已读只影响你自己的收件箱。
          </p>
        </div>
        <Button
          type="button"
          variant={unreadOnly ? 'primary' : 'secondary'}
          aria-pressed={unreadOnly}
          onClick={() => {
            setPage(1);
            setUnreadOnly((value) => !value);
          }}
        >
          只看未读
        </Button>
      </div>

      {query.isPending ? <LoadingState title="正在加载通知" /> : null}
      {query.isError ? (
        <ErrorState
          {...errorCopy(query.error, '通知')}
          action={
            <Button type="button" variant="secondary" onClick={() => query.refetch()}>
              重新加载
            </Button>
          }
        />
      ) : null}
      {query.data && query.data.total === 0 ? (
        <EmptyState
          title={unreadOnly ? '没有未读通知' : '还没有通知'}
          description="审批通过、退回或拒绝时，你会在这里收到提醒。"
        />
      ) : null}
      {query.data && query.data.total > 0 && query.data.items.length === 0 ? (
        <EmptyState
          title="本页没有通知了"
          description="读掉本页最后一条后页码会越界，回到第一页即可继续。"
          action={
            <Button type="button" variant="secondary" onClick={() => setPage(1)}>
              回到第一页
            </Button>
          }
        />
      ) : null}

      {query.data && query.data.items.length > 0 ? (
        <div className="mt-6 space-y-3">
          <p className="text-sm text-muted">未读 {query.data.unread} 条</p>
          {query.data.items.map((item) => (
            <Card key={item.id}>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold text-ink">{item.title}</h2>
                  <span className="text-xs text-muted">
                    {item.status === 'UNREAD' ? '未读' : '已读'} ·{' '}
                    {item.createdAt.slice(0, 19).replace('T', ' ')}
                  </span>
                </div>
                {item.body ? <p className="text-sm">{item.body}</p> : null}
                <div className="flex flex-wrap items-center gap-3">
                  {item.resourceType === 'WORK_LOG' && item.resourceId ? (
                    <Link className="text-sm underline" href={`/worklogs/${item.resourceId}`}>
                      查看工作日志
                    </Link>
                  ) : null}
                  {item.status === 'UNREAD' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={markRead.isPending && markRead.variables === item.id}
                      onClick={() => markRead.mutate(item.id)}
                    >
                      标记已读
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted">
              共 {query.data.total} 条，第 {query.data.page} 页
            </p>
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
        </div>
      ) : null}

      {markRead.isError ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {markRead.error instanceof ApiError && markRead.error.status === 404
            ? markRead.error.message
            : errorCopy(markRead.error, '通知', '更新').description}
        </p>
      ) : null}
    </AppShell>
  );
}
