'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';

/**
 * 报表页。作用域与下钻授权都由服务端决定：
 * 页面只负责把"能不能下钻"如实呈现，绝不以隐藏按钮代替授权。
 */
export default function ReportsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [drilldownProject, setDrilldownProject] = useState<string | null>(null);
  const range = { from: from || undefined, to: to || undefined };

  const rangeInvalid = Boolean(from && to && from > to);

  const summary = useQuery({
    queryKey: ['reports', 'summary', range],
    queryFn: () => api.reportSummary(range),
    // 400 是输入错误，重试不会变好。
    retry: false,
    enabled: !rangeInvalid,
  });
  const byProject = useQuery({
    queryKey: ['reports', 'projects', range],
    queryFn: () => api.reportByProject(range),
    retry: false,
    enabled: !rangeInvalid,
  });
  const drilldown = useQuery({
    queryKey: ['reports', 'drilldown', drilldownProject, range],
    queryFn: () => api.reportDrilldown(drilldownProject!, range),
    enabled: drilldownProject !== null && !rangeInvalid,
    retry: false,
  });

  const returnRate = summary.data ? Math.round(summary.data.approvals.returnRate * 1000) / 10 : 0;

  /** 400 是"你的输入不合法"，必须把服务端原因原样展示；其余状态给统一文案。 */
  const reportError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 400) {
      return { title: '日期区间不合法', description: error.message };
    }
    return errorCopy(error, '报表');
  };

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">汇总与核对</p>
          <h1 className="text-2xl font-semibold text-ink">报表</h1>
          <p className="mt-1 text-sm text-muted">
            默认最近 7 个业务日（{summary.data?.range.timezone ?? 'Australia/Melbourne'}）；
            工时只统计已提交的当前版本。
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
      {!rangeInvalid && summary.isPending ? <LoadingState title="正在加载报表" /> : null}
      {summary.isError ? (
        <div role="alert">
          <ErrorState
            {...reportError(summary.error)}
            action={
              summary.error instanceof ApiError && summary.error.status === 400 ? undefined : (
                <Button type="button" variant="secondary" onClick={() => summary.refetch()}>
                  重新加载
                </Button>
              )
            }
          />
        </div>
      ) : null}

      {summary.data ? (
        <>
          <p className="mt-4 text-sm text-muted">
            {summary.data.range.from} 至 {summary.data.range.to}
            {summary.data.scope === 'OWN' ? ' · 仅本人数据' : ' · 授权项目汇总'}
            {' · '}
            范围内项目 {summary.data.projects.inScope} 个 · 本区间有记录{' '}
            {summary.data.projects.withActivity} 个{' · '}
            待审为实时值（快照 {summary.data.approvals.pendingAsOf}）
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="投入工时" value={`${summary.data.hours.total} h`} />
            <Metric label="待审（实时）" value={String(summary.data.approvals.pending)} />
            <Metric
              label="审批结果"
              value={`通过 ${summary.data.approvals.decided.approved} · 退回 ${summary.data.approvals.decided.returned} · 拒绝 ${summary.data.approvals.decided.rejected}`}
            />
            <Metric label="退回率" value={`${returnRate}%`} />
          </div>
          {summary.data.hours.truncated ? (
            <p className="mt-2 text-sm text-danger" role="alert">
              工时统计达到单次上限（{summary.data.hours.limit}{' '}
              条日志），当前数字可能偏小；请缩短日期区间。
            </p>
          ) : null}
        </>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-lg font-semibold text-ink">按项目</h2>
        </CardHeader>
        <CardContent>
          {!rangeInvalid && byProject.isPending ? <LoadingState title="正在加载项目汇总" /> : null}
          {byProject.isError &&
          !(byProject.error instanceof ApiError && byProject.error.status === 400) ? (
            <div role="alert">
              <ErrorState
                {...reportError(byProject.error)}
                action={
                  byProject.error instanceof ApiError &&
                  byProject.error.status === 400 ? undefined : (
                    <Button type="button" variant="secondary" onClick={() => byProject.refetch()}>
                      重新加载
                    </Button>
                  )
                }
              />
            </div>
          ) : null}
          {byProject.data && byProject.data.items.length === 0 ? (
            <EmptyState
              title="该区间没有工时"
              description="换一个日期区间，或确认日志是否已提交。"
            />
          ) : null}
          {byProject.data && byProject.data.items.length > 0 ? (
            <>
              <TableContainer>
                <Table>
                  <thead>
                    <tr>
                      <TableHead>项目</TableHead>
                      <TableHead>工时</TableHead>
                      <TableHead>通过</TableHead>
                      <TableHead>退回</TableHead>
                      <TableHead>拒绝</TableHead>
                      <TableHead>退回率</TableHead>
                      <TableHead>明细</TableHead>
                    </tr>
                  </thead>
                  <tbody>
                    {byProject.data.items.map((row) => (
                      <tr key={row.projectId} className="border-t border-border">
                        <TableCell>
                          <span className="font-mono text-xs">{row.number}</span> {row.name}
                        </TableCell>
                        <TableCell>{row.hours} h</TableCell>
                        <TableCell>{row.approved}</TableCell>
                        <TableCell>{row.returned}</TableCell>
                        <TableCell>{row.rejected}</TableCell>
                        <TableCell>{Math.round(row.returnRate * 1000) / 10}%</TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setDrilldownProject(row.projectId)}
                          >
                            查看明细
                          </Button>
                        </TableCell>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableContainer>
              {byProject.data.truncated ? (
                <p className="mt-2 text-sm text-danger" role="alert">
                  {byProject.data.truncatedReasons.includes('WORK_LOG_ROW_LIMIT')
                    ? `日志条数达到单次上限（${byProject.data.limit} 条），工时可能偏小；`
                    : ''}
                  {byProject.data.truncatedReasons.includes('DECISION_ROW_LIMIT')
                    ? `决策记录达到单次上限（${byProject.data.limit} 条），退回率可能偏低；`
                    : ''}
                  {byProject.data.truncatedReasons.length === 0
                    ? '结果已截断，数字可能不完整；'
                    : ''}
                  请缩短日期区间后重试。
                </p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {drilldownProject ? (
        <Card className="mt-6">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-ink">工作日志明细</h2>
              <Button type="button" variant="secondary" onClick={() => setDrilldownProject(null)}>
                收起
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {drilldown.isPending ? <LoadingState title="正在加载明细" /> : null}
            {drilldown.isError ? (
              <div role="alert">
                <ErrorState
                  {...(drilldown.error instanceof ApiError && drilldown.error.status === 403
                    ? {
                        title: '没有下钻权限',
                        description:
                          '查看客户或个人级明细需要单独授予「报表下钻」能力，聚合数据不受影响。',
                      }
                    : reportError(drilldown.error))}
                />
              </div>
            ) : null}
            {drilldown.data && drilldown.data.items.length === 0 ? (
              <EmptyState title="该区间没有明细" description="换一个日期区间再试。" />
            ) : null}
            {drilldown.data && drilldown.data.items.length > 0 ? (
              <>
                <TableContainer>
                  <Table>
                    <thead>
                      <tr>
                        <TableHead>编号</TableHead>
                        <TableHead>作者</TableHead>
                        <TableHead>日期</TableHead>
                        <TableHead>版本</TableHead>
                        <TableHead>工时</TableHead>
                        <TableHead>完成内容</TableHead>
                      </tr>
                    </thead>
                    <tbody>
                      {drilldown.data.items.map((row) => (
                        <tr
                          key={`${row.workLogId}-${row.versionNumber}`}
                          className="border-t border-border"
                        >
                          <TableCell className="font-mono text-xs">{row.number}</TableCell>
                          <TableCell>{row.author.name}</TableCell>
                          <TableCell>{String(row.workDate).slice(0, 10)}</TableCell>
                          <TableCell>v{row.versionNumber}</TableCell>
                          <TableCell>{row.hours} h</TableCell>
                          <TableCell>{row.completion}</TableCell>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableContainer>
                {drilldown.data.truncated ? (
                  <p className="mt-2 text-sm text-danger" role="alert">
                    明细超过单次上限，仅显示最近 {drilldown.data.limit} 条；请缩短日期区间。
                  </p>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted">{label}</p>
        <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
      </CardContent>
    </Card>
  );
}
