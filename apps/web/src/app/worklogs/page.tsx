'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, type WorkLogStatus, type WorkLogVisibility } from '@/lib/api';

const statusLabels: Record<WorkLogStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  APPROVED: '已通过',
  RETURNED: '退回修改',
  REJECTED: '已拒绝',
};

const visibilityLabels: Record<WorkLogVisibility, string> = {
  PRIVATE: '仅本人',
  PROJECT_VISIBLE: '项目可见',
};

const PAGE_SIZE = 20;

/**
 * 我的工作日志列表。只展示本人日志（服务端按 author 作用域过滤），
 * 状态与可见性直接映射为文字，不只依赖颜色。
 */
export default function MyWorkLogsPage() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['my-work-logs', page],
    queryFn: () => api.listMyWorkLogs({ page, pageSize: PAGE_SIZE }),
  });

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">日常工作</p>
          <h1 className="text-2xl font-semibold text-ink">我的工作日志</h1>
          <p className="mt-1 text-sm text-muted">
            记录工作内容与工时；提交后内容冻结，退回修改会生成新版本。
          </p>
        </div>
        <Button asChild>
          <Link href="/worklogs/new">记录工作日志</Link>
        </Button>
      </div>

      <Card className="mt-6">
        <CardContent>
          {query.isPending ? <LoadingState title="正在加载工作日志" /> : null}
          {query.isError ? (
            <ErrorState
              {...errorCopy(query.error, '工作日志')}
              action={
                <Button type="button" variant="secondary" onClick={() => query.refetch()}>
                  重新加载
                </Button>
              }
            />
          ) : null}
          {query.data && query.data.items.length === 0 ? (
            <EmptyState
              title="还没有工作日志"
              description="创建第一份草稿，填写日期、工时与完成内容。"
            />
          ) : null}
          {query.data && query.data.items.length > 0 ? (
            <>
              <TableContainer>
                <Table>
                  <thead>
                    <tr>
                      <TableHead>编号</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>工作日期</TableHead>
                      <TableHead>工时</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>可见性</TableHead>
                      <TableHead>版本</TableHead>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.items.map((item) => (
                      <tr key={item.id} className="border-t border-border">
                        <TableCell className="font-mono text-xs">
                          <Link className="underline" href={`/worklogs/${item.id}`}>
                            {item.number}
                          </Link>
                        </TableCell>
                        <TableCell>{item.project?.name ?? '未关联项目'}</TableCell>
                        <TableCell>{item.currentVersion?.workDate?.slice(0, 10) ?? '—'}</TableCell>
                        <TableCell>{item.currentVersion?.hours ?? '—'}</TableCell>
                        <TableCell>{statusLabels[item.status]}</TableCell>
                        <TableCell>{visibilityLabels[item.visibility]}</TableCell>
                        <TableCell>v{item.currentVersion?.versionNumber ?? '—'}</TableCell>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableContainer>
              <div className="mt-4 flex items-center justify-between gap-4">
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
            </>
          ) : null}
        </CardContent>
      </Card>
    </AppShell>
  );
}
