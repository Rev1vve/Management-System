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

/**
 * 项目集视图：只包含调用者**属于**的项目集（服务端按 PortfolioMembership 判定）。
 * 聚合只给汇总数字——客户/个人级明细仍需要单独的下钻能力。
 */
export default function PortfolioOverviewPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = { from: from || undefined, to: to || undefined };
  const rangeInvalid = Boolean(from && to && from > to);

  const query = useQuery({
    queryKey: ['reports', 'portfolios', range],
    queryFn: () => api.reportPortfolios(range),
    retry: false,
    enabled: !rangeInvalid,
  });

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">项目集视角</p>
          <h1 className="text-2xl font-semibold text-ink">项目集总览</h1>
          <p className="mt-1 text-sm text-muted">
            只统计你所属项目集下的项目；汇总不含个人与客户级明细。
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
      {!rangeInvalid && query.isPending ? <LoadingState title="正在加载项目集" /> : null}
      {query.isError ? (
        <div role="alert">
          <ErrorState
            {...(query.error instanceof ApiError && query.error.status === 400
              ? { title: '日期区间不合法', description: query.error.message }
              : errorCopy(query.error, '项目集'))}
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

      {query.data && query.data.portfoliosTotal === 0 ? (
        <EmptyState
          title="你还不属于任何项目集"
          description="被加入项目集后，这里会显示该集下的跨项目汇总。"
        />
      ) : null}
      {query.data && query.data.portfoliosTotal > 0 && query.data.items.length === 0 ? (
        <EmptyState
          title="所属项目集下暂无进行中的项目"
          description="项目集里还没有未归档的项目，或这些项目都被归档了。"
        />
      ) : null}

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
                    <TableHead>项目集</TableHead>
                    <TableHead>项目数</TableHead>
                    <TableHead>工时</TableHead>
                    <TableHead>通过</TableHead>
                    <TableHead>退回</TableHead>
                    <TableHead>拒绝</TableHead>
                    <TableHead>退回率</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((row) => (
                    <tr key={row.portfolioId} className="border-t border-border">
                      <TableCell>{row.name}</TableCell>
                      <TableCell>{row.projects}</TableCell>
                      <TableCell>{row.hours} h</TableCell>
                      <TableCell>{row.approved}</TableCell>
                      <TableCell>{row.returned}</TableCell>
                      <TableCell>{row.rejected}</TableCell>
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
