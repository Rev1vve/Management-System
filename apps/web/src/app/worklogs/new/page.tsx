'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';

const schema = z.object({
  projectId: z.string().trim().min(1, '请选择项目'),
  workDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式为 YYYY-MM-DD'),
  // 与既有表单一致：用 valueAsNumber 注册，schema 保持 z.number()。
  hours: z
    .number({ message: '工时必须是数字' })
    .gt(0, '工时必须大于 0')
    .max(24, '工时不得超过 24')
    // 浮点乘法会把 1.15 之类判成三位小数；这里用容差判断，与后端字符串解析保持一致。
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, '工时最多两位小数'),
  completion: z.string().trim().min(1, '请填写完成内容').max(5000),
  progressNote: z.string().trim().max(5000).optional(),
});
type Values = z.infer<typeof schema>;

export default function NewWorkLogPage() {
  const router = useRouter();
  const projects = useQuery({
    queryKey: ['projects', 'worklog-options'],
    queryFn: () => api.listProjects({ page: 1, pageSize: 100, search: '', status: 'ACTIVE' }),
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { projectId: '', workDate: '', hours: 1, completion: '', progressNote: '' },
  });
  const mutation = useMutation({
    mutationFn: (values: Values) =>
      api.createWorkLog({
        projectId: values.projectId,
        workDate: values.workDate,
        hours: values.hours,
        completion: values.completion,
        progressNote: values.progressNote || null,
      }),
    onSuccess: (created) => router.push(`/worklogs/${encodeURIComponent(created.id)}`),
  });

  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href="/worklogs">
        返回我的工作日志
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-ink">记录工作日志</h1>
      <p className="mt-1 text-sm text-muted">
        先保存为草稿；草稿可以继续编辑并上传附件，提交后内容冻结。
      </p>

      <Card className="mt-6 max-w-2xl">
        <CardContent>
          {projects.isPending ? <LoadingState title="正在加载可选项目" /> : null}
          {projects.isError ? (
            <ErrorState
              {...errorCopy(projects.error, '项目')}
              action={
                <Button type="button" variant="secondary" onClick={() => projects.refetch()}>
                  重新加载
                </Button>
              }
            />
          ) : null}
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            noValidate
          >
            <label className="block text-sm font-medium text-ink">
              项目
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-border bg-card px-3"
                {...form.register('projectId')}
              >
                <option value="">请选择项目</option>
                {(projects.data?.items ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.number} · {project.name}
                  </option>
                ))}
              </select>
              {form.formState.errors.projectId ? (
                <span className="mt-1 block text-sm text-danger">
                  {form.formState.errors.projectId.message}
                </span>
              ) : null}
            </label>

            <label className="block text-sm font-medium text-ink">
              工作日期
              <Input type="date" className="mt-1" {...form.register('workDate')} />
              {form.formState.errors.workDate ? (
                <span className="mt-1 block text-sm text-danger">
                  {form.formState.errors.workDate.message}
                </span>
              ) : null}
            </label>

            <label className="block text-sm font-medium text-ink">
              工时（小时）
              <Input
                type="number"
                step="0.25"
                min="0"
                className="mt-1"
                {...form.register('hours', { valueAsNumber: true })}
              />
              {form.formState.errors.hours ? (
                <span className="mt-1 block text-sm text-danger">
                  {form.formState.errors.hours.message}
                </span>
              ) : null}
            </label>

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

            {mutation.isError ? (
              <p className="text-sm text-danger" role="alert">
                {mutation.error instanceof ApiError &&
                (mutation.error.status === 400 || mutation.error.status === 404)
                  ? mutation.error.message
                  : `${errorCopy(mutation.error, '工作日志', '保存').title}：${
                      errorCopy(mutation.error, '工作日志', '保存').description
                    }`}
              </p>
            ) : null}

            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? '正在保存…' : '保存草稿'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
