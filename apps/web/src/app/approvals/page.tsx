'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { api, ApiError, type ApprovalDecision } from '@/lib/api';

const PAGE_SIZE = 20;

const decisionLabels: Record<ApprovalDecision, string> = {
  APPROVED: '通过',
  RETURNED: '退回修改',
  REJECTED: '拒绝',
};

/**
 * 待办审批。只有被指定为审批人的请求会出现在这里（服务端按审批人作用域过滤），
 * 且 `canDecide=false` 的请求（版本已被替换 / 已离开待审批）会置灰，避免点了才 409。
 */
export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['approvals', page],
    queryFn: () => api.listApprovals({ page, pageSize: PAGE_SIZE }),
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; decision: ApprovalDecision; comment: string }) =>
      api.decideApproval(input.id, {
        decision: input.decision,
        comment: input.comment.trim() ? input.comment.trim() : null,
      }),
    onSuccess: async () => {
      setFeedback('审批已提交');
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">需要你处理</p>
          <h1 className="text-2xl font-semibold text-ink">待办审批</h1>
          <p className="mt-1 text-sm text-muted">
            只能处理指定给你的请求；通过、退回或拒绝都会立即写入日志状态与通知。
          </p>
        </div>
        <Button asChild variant="secondary">
          <Link href="/notifications">通知中心</Link>
        </Button>
      </div>

      {feedback ? (
        <p className="mt-4 text-sm text-success" role="status">
          {feedback}
        </p>
      ) : null}

      {query.isPending ? <LoadingState title="正在加载待办审批" /> : null}
      {query.isError ? (
        <ErrorState
          {...errorCopy(query.error, '待办审批')}
          action={
            <Button type="button" variant="secondary" onClick={() => query.refetch()}>
              重新加载
            </Button>
          }
        />
      ) : null}
      {query.data && query.data.total === 0 ? (
        <EmptyState
          title="没有待办审批"
          description="所有提交都已处理，或暂时没有分配给你的请求。"
        />
      ) : null}
      {query.data && query.data.total > 0 && query.data.items.length === 0 ? (
        <EmptyState
          title="本页已经没有待办"
          description="处理完本页最后一条后页码会越界，回到第一页即可继续。"
          action={
            <Button type="button" variant="secondary" onClick={() => setPage(1)}>
              回到第一页
            </Button>
          }
        />
      ) : null}

      {query.data && query.data.items.length > 0 ? (
        <div className="mt-6 space-y-4">
          {query.data.items.map((item) => (
            <ApprovalCard
              key={item.id}
              item={item}
              pending={decide.isPending && decide.variables?.id === item.id}
              onDecide={(decision, comment) => decide.mutate({ id: item.id, decision, comment })}
            />
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

      {decide.isError ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {decide.error instanceof ApiError &&
          (decide.error.status === 400 || decide.error.status === 409)
            ? decide.error.message
            : errorCopy(decide.error, '审批', '处理').description}
        </p>
      ) : null}
    </AppShell>
  );
}

function ApprovalCard({
  item,
  pending,
  onDecide,
}: {
  item: {
    id: string;
    submittedAt: string;
    canDecide: boolean;
    workLogVersion: {
      versionNumber: number;
      workDate: string;
      hours: string | number;
      completion: string;
      workLog: {
        id: string;
        number: string;
        project: { name: string } | null;
        author: { name: string };
      };
    };
  };
  pending: boolean;
  onDecide: (decision: ApprovalDecision, comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const needsComment = (decision: ApprovalDecision) => decision !== 'APPROVED';
  const [decision, setDecision] = useState<ApprovalDecision>('APPROVED');
  const missingComment = needsComment(decision) && comment.trim().length === 0;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink">
            <Link className="underline" href={`/worklogs/${item.workLogVersion.workLog.id}`}>
              {item.workLogVersion.workLog.number}
            </Link>
            <span className="ml-2 text-sm text-muted">v{item.workLogVersion.versionNumber}</span>
          </h2>
          <p className="text-sm text-muted">
            {item.workLogVersion.workLog.project?.name ?? '未关联项目'} ·{' '}
            {item.workLogVersion.workLog.author.name} 提交
          </p>
        </div>

        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">工作日期</dt>
            <dd>{item.workLogVersion.workDate.slice(0, 10)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">工时</dt>
            <dd>{item.workLogVersion.hours}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">提交时间</dt>
            <dd>{item.submittedAt.slice(0, 19).replace('T', ' ')}</dd>
          </div>
        </dl>

        <p className="whitespace-pre-wrap text-sm">{item.workLogVersion.completion}</p>

        {item.canDecide ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="group" aria-label="选择审批结论">
              {(Object.keys(decisionLabels) as ApprovalDecision[]).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={decision === value ? 'primary' : 'secondary'}
                  aria-pressed={decision === value}
                  onClick={() => setDecision(value)}
                >
                  {decisionLabels[value]}
                </Button>
              ))}
            </div>
            <label className="block text-sm font-medium text-ink">
              审批意见{needsComment(decision) ? '（退回/拒绝必填）' : '（可选）'}
              <textarea
                className="mt-1 min-h-20 w-full rounded-md border border-border bg-card px-3 py-2"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </label>
            <Button
              type="button"
              disabled={pending || missingComment}
              onClick={() => onDecide(decision, comment)}
            >
              {pending ? '正在提交…' : `确认${decisionLabels[decision]}`}
            </Button>
            {missingComment ? (
              <p className="text-xs text-muted">退回或拒绝必须填写审批意见。</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">
            该请求绑定的版本已不是当前版本，无法处理；请联系提交人重新提交或由管理员清理。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
