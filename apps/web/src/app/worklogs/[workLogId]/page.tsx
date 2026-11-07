'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';
import {
  api,
  ApiError,
  type WorkLogDetail,
  type WorkLogStatus,
  type WorkLogVisibility,
} from '@/lib/api';

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

const contentSchema = z.object({
  workDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式为 YYYY-MM-DD'),
  hours: z
    .number({ message: '工时必须是数字' })
    .gt(0, '工时必须大于 0')
    .max(24, '工时不得超过 24')
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, '工时最多两位小数'),
  completion: z.string().trim().min(1, '请填写完成内容').max(5000),
  progressNote: z.string().trim().max(5000).optional(),
});
type ContentValues = z.infer<typeof contentSchema>;

/** 草稿编辑与退回后开新版本共用同一套内容表单，区别只在提交的接口与令牌语义。 */
function ContentForm({
  initial,
  submitLabel,
  pendingLabel,
  onSubmit,
  error,
  formatError,
}: {
  initial: ContentValues;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (values: ContentValues) => void;
  error: unknown;
  formatError: (error: unknown) => string;
}) {
  const form = useForm<ContentValues>({
    resolver: zodResolver(contentSchema),
    defaultValues: initial,
  });
  return (
    <form
      className="space-y-3"
      onSubmit={form.handleSubmit((values) => onSubmit(values))}
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-ink">
          工作日期
          <Input type="date" className="mt-1" {...form.register('workDate')} />
          {form.formState.errors.workDate ? (
            <span className="mt-1 block text-sm text-danger">
              {form.formState.errors.workDate.message}
            </span>
          ) : null}
        </label>
        <label className="text-sm font-medium text-ink">
          工时（小时）
          <Input
            type="number"
            step="0.25"
            className="mt-1"
            {...form.register('hours', { valueAsNumber: true })}
          />
          {form.formState.errors.hours ? (
            <span className="mt-1 block text-sm text-danger">
              {form.formState.errors.hours.message}
            </span>
          ) : null}
        </label>
      </div>
      <label className="block text-sm font-medium text-ink">
        完成内容
        <textarea
          className="mt-1 min-h-24 w-full rounded-md border border-border bg-card px-3 py-2"
          {...form.register('completion')}
        />
        {form.formState.errors.completion ? (
          <span className="mt-1 block text-sm text-danger">
            {form.formState.errors.completion.message}
          </span>
        ) : null}
      </label>
      <label className="block text-sm font-medium text-ink">
        进度说明（可选）
        <textarea
          className="mt-1 min-h-20 w-full rounded-md border border-border bg-card px-3 py-2"
          {...form.register('progressNote')}
        />
      </label>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {formatError(error)}
        </p>
      ) : null}
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}

/**
 * 工作日志详情。
 *
 * 所有写操作都带上服务端返回的乐观并发令牌 `version`；提交与退回后开新版本
 * 都会让令牌前进，页面在成功后重新拉取，避免用旧令牌继续写。
 */
export default function WorkLogDetailPage() {
  const params = useParams<{ workLogId: string }>();
  const workLogId = decodeURIComponent(String(params.workLogId));
  const queryClient = useQueryClient();
  const [approverId, setApproverId] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  // 被服务端拒绝过（403）之后，可见性控件降级为只读，避免让无权限的人一直点。
  const [visibilityLocked, setVisibilityLocked] = useState(false);

  const detail = useQuery({
    queryKey: ['work-log', workLogId],
    queryFn: () => api.getWorkLog(workLogId),
  });
  const attachments = useQuery({
    queryKey: ['work-log-attachments', workLogId],
    queryFn: () => api.listWorkLogAttachments(workLogId),
  });

  /**
   * 写操作的错误展示：400/404 是**具体的**业务拒绝（如"审批人不合格""附件不存在"），
   * 服务端文案已经可读，直接展示；其余状态用统一文案，避免把内部细节漏出去。
   */
  const operationError = (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.status === 400 || error.status === 404) return error.message;
      const copy = errorCopy(error, '工作日志', '操作');
      return `${copy.title}：${copy.description}`;
    }
    return '操作失败，请稍后重试。';
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['work-log', workLogId] }),
      queryClient.invalidateQueries({ queryKey: ['work-log-attachments', workLogId] }),
    ]);
  };

  const submit = useMutation({
    mutationFn: (data: { approverId: string }) => api.submitWorkLog(workLogId, data),
    onSuccess: async () => {
      setFeedback('已提交审批');
      await refresh();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) await refresh();
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadWorkLogAttachment(workLogId, file),
    onSuccess: async () => {
      setFeedback('附件已上传');
      await refresh();
    },
  });
  const archiveAttachment = useMutation({
    mutationFn: (attachmentId: string) => api.archiveWorkLogAttachment(workLogId, attachmentId),
    onSuccess: async () => {
      setFeedback('附件已删除');
      await refresh();
    },
  });
  const editDraft = useMutation({
    mutationFn: (values: ContentValues) =>
      api.updateWorkLogDraft(workLogId, {
        version: detail.data!.version,
        workDate: values.workDate,
        hours: values.hours,
        completion: values.completion,
        progressNote: values.progressNote || null,
      }),
    onSuccess: async () => {
      setFeedback('草稿已保存');
      await refresh();
    },
    onError: async (error) => {
      // 409 说明令牌过期：自动刷新，避免用户对着旧令牌反复失败。
      if (error instanceof ApiError && error.status === 409) await refresh();
    },
  });
  const addVersion = useMutation({
    mutationFn: (values: ContentValues) =>
      api.addWorkLogVersion(workLogId, {
        workDate: values.workDate,
        hours: values.hours,
        completion: values.completion,
        progressNote: values.progressNote || null,
      }),
    onSuccess: async () => {
      setFeedback('已创建新草稿版本');
      await refresh();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) await refresh();
    },
  });
  const setVisibility = useMutation({
    mutationFn: (data: { visibility: WorkLogVisibility; version: number }) =>
      api.setWorkLogVisibility(workLogId, data),
    onSuccess: async () => {
      setFeedback('可见性已更新');
      await refresh();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) await refresh();
      if (error instanceof ApiError && error.status === 403) setVisibilityLocked(true);
    },
  });

  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href="/worklogs">
        返回我的工作日志
      </Link>

      {detail.isPending ? <LoadingState title="正在加载工作日志" /> : null}
      {detail.isError ? (
        <ErrorState
          {...errorCopy(detail.error, '工作日志')}
          action={
            <Button type="button" variant="secondary" onClick={() => detail.refetch()}>
              重新加载
            </Button>
          }
        />
      ) : null}

      {detail.data ? <DetailBody detail={detail.data} /> : null}

      {detail.data ? (
        <Card className="mt-6">
          <CardHeader>
            <h2 className="text-lg font-semibold text-ink">操作</h2>
          </CardHeader>
          <CardContent className="space-y-4">
            {detail.data.status === 'DRAFT' ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm font-medium text-ink">
                  指定审批人（用户 ID，需具备该项目审批人角色或审批决策能力）
                  <Input
                    className="mt-1"
                    value={approverId}
                    onChange={(event) => setApproverId(event.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  disabled={submit.isPending || approverId.trim().length === 0}
                  onClick={() => submit.mutate({ approverId: approverId.trim() })}
                >
                  {submit.isPending ? '正在提交…' : '提交审批'}
                </Button>
              </div>
            ) : detail.data.status === 'RETURNED' ? (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  已退回修改：保存会生成新草稿版本，旧版本与审批记录保持不变。
                </p>
                <ContentForm
                  initial={{
                    workDate: detail.data.currentVersion?.workDate.slice(0, 10) ?? '',
                    hours: Number(detail.data.currentVersion?.hours ?? 1),
                    completion: detail.data.currentVersion?.completion ?? '',
                    progressNote: detail.data.currentVersion?.progressNote ?? '',
                  }}
                  submitLabel="保存为新版本"
                  pendingLabel="正在保存…"
                  onSubmit={(values) => addVersion.mutate(values)}
                  error={addVersion.error}
                  formatError={operationError}
                />
              </div>
            ) : (
              <p className="text-sm text-muted">
                当前状态为{statusLabels[detail.data.status]}，内容已冻结，不能直接修改。
              </p>
            )}

            {detail.data.status === 'DRAFT' ? (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-ink">编辑草稿</h3>
                <ContentForm
                  initial={{
                    workDate: detail.data.currentVersion?.workDate.slice(0, 10) ?? '',
                    hours: Number(detail.data.currentVersion?.hours ?? 1),
                    completion: detail.data.currentVersion?.completion ?? '',
                    progressNote: detail.data.currentVersion?.progressNote ?? '',
                  }}
                  submitLabel="保存修改"
                  pendingLabel="正在保存…"
                  onSubmit={(values) => editDraft.mutate(values)}
                  error={editDraft.error}
                  formatError={operationError}
                />
              </div>
            ) : null}

            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm font-medium text-ink">
                可见性
                {visibilityLocked ? (
                  <p className="mt-1 min-h-11 rounded-md border border-border bg-card px-3 py-3 text-sm">
                    {visibilityLabels[detail.data.visibility]}（无修改权限）
                  </p>
                ) : (
                  <select
                    className="mt-1 min-h-11 rounded-md border border-border bg-card px-3"
                    value={detail.data.visibility}
                    onChange={(event) =>
                      setVisibility.mutate({
                        visibility: event.target.value as WorkLogVisibility,
                        version: detail.data.version,
                      })
                    }
                  >
                    {Object.entries(visibilityLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <p className="text-xs text-muted">
                仅项目经理或具备工作日志管理能力的人可以修改；服务端会再次校验。
              </p>
            </div>

            {detail.data.status === 'DRAFT' ? (
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm font-medium text-ink">
                  上传附件
                  <Input
                    type="file"
                    className="mt-1"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) upload.mutate(file);
                    }}
                  />
                </label>
              </div>
            ) : null}

            {submit.isError ||
            upload.isError ||
            archiveAttachment.isError ||
            setVisibility.isError ? (
              <p className="text-sm text-danger" role="alert">
                {operationError(
                  submit.error ?? upload.error ?? archiveAttachment.error ?? setVisibility.error,
                )}
              </p>
            ) : null}
            {feedback ? (
              <p className="text-sm text-success" role="status">
                {feedback}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {detail.data ? (
        <Card className="mt-6">
          <CardHeader>
            <h2 className="text-lg font-semibold text-ink">附件</h2>
          </CardHeader>
          <CardContent>
            {attachments.isError ? (
              <ErrorState
                {...errorCopy(attachments.error, '附件')}
                action={
                  <Button type="button" variant="secondary" onClick={() => attachments.refetch()}>
                    重新加载
                  </Button>
                }
              />
            ) : null}
            {attachments.isPending ? <LoadingState title="正在加载附件" /> : null}
            {!attachments.isError &&
            !attachments.isPending &&
            (attachments.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">暂无附件</p>
            ) : null}
            {!attachments.isError && (attachments.data ?? []).length > 0 ? (
              <ul className="space-y-2">
                {(attachments.data ?? []).map((attachment) => (
                  <li key={attachment.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <a
                      className="min-h-11 items-center underline"
                      href={api.workLogAttachmentDownloadUrl(workLogId, attachment.id)}
                    >
                      {attachment.originalName}
                    </a>
                    <span className="text-muted">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
                    {detail.data?.status === 'DRAFT' ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => archiveAttachment.mutate(attachment.id)}
                      >
                        删除
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}

function DetailBody({ detail }: { detail: WorkLogDetail }) {
  return (
    <Card className="mt-4">
      <CardHeader>
        <h1 className="text-2xl font-semibold text-ink">{detail.number}</h1>
        <p className="text-sm text-muted">
          {statusLabels[detail.status]} · {visibilityLabels[detail.visibility]} · 乐观并发令牌 v
          {detail.version}
        </p>
      </CardHeader>
      <CardContent>
        {detail.currentVersion ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">工作日期</dt>
              <dd>{detail.currentVersion.workDate.slice(0, 10)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">工时</dt>
              <dd>{detail.currentVersion.hours}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted">完成内容</dt>
              <dd className="whitespace-pre-wrap">{detail.currentVersion.completion}</dd>
            </div>
            {detail.currentVersion.progressNote ? (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted">进度说明</dt>
                <dd className="whitespace-pre-wrap">{detail.currentVersion.progressNote}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-muted">该日志还没有版本内容</p>
        )}

        <h2 className="mt-6 text-sm font-semibold text-ink">版本历史</h2>
        <ul className="mt-2 space-y-1 text-sm text-muted">
          {detail.versions.map((version) => (
            <li key={version.id}>
              v{version.versionNumber} · {version.submittedAt.slice(0, 19).replace('T', ' ')}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
