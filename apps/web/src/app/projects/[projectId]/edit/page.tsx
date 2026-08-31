'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { api, ApiError, ProjectSummary } from '@/lib/api';

const schema = z.object({
  number: z.string().trim().min(1, '请输入项目编号').max(100),
  name: z.string().trim().min(1, '请输入项目名称').max(200),
  customerId: z.string().trim().max(100),
  portfolioId: z.string().trim().max(100),
  description: z.string().max(4000),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED']),
  completionPercent: z
    .string()
    .regex(/^\d+$/, '完成进度必须是 0-100 的整数')
    .refine((value) => Number(value) <= 100, '完成进度必须是 0-100 的整数'),
});
type Values = z.infer<typeof schema>;
const statuses = { DRAFT: '草稿', ACTIVE: '进行中', ON_HOLD: '暂停', COMPLETED: '已完成' } as const;
const labelClass = 'block text-sm font-medium';
const selectClass =
  'mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3';
const dateValue = (value?: string | null) => (value ? value.slice(0, 10) : '');

function ProjectForm({
  project,
}: {
  project: ProjectSummary & { status: Exclude<ProjectSummary['status'], 'ARCHIVED'> };
}) {
  const router = useRouter();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      number: project.number,
      name: project.name,
      customerId: project.customer?.id ?? '',
      portfolioId: project.portfolio?.id ?? '',
      description: project.description ?? '',
      startDate: dateValue(project.startDate),
      endDate: dateValue(project.endDate),
      status: project.status,
      completionPercent: String(project.completionPercent),
    },
  });
  useEffect(
    () =>
      form.reset({
        number: project.number,
        name: project.name,
        customerId: project.customer?.id ?? '',
        portfolioId: project.portfolio?.id ?? '',
        description: project.description ?? '',
        startDate: dateValue(project.startDate),
        endDate: dateValue(project.endDate),
        status: project.status,
        completionPercent: String(project.completionPercent),
      }),
    [form, project],
  );
  const mutation = useMutation({
    mutationFn: (values: Values) =>
      api.updateProject(project.id, {
        number: values.number,
        name: values.name,
        customerId: values.customerId || null,
        portfolioId: values.portfolioId || null,
        description: values.description || null,
        startDate: values.startDate || null,
        endDate: values.endDate || null,
        status: values.status,
        completionPercent: Number(values.completionPercent),
        version: project.version,
      }),
    onSuccess: () => router.push(`/projects/${encodeURIComponent(project.id)}`),
  });
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <label className={labelClass}>
        项目编号
        <Input {...form.register('number')} />
        {form.formState.errors.number ? (
          <span role="alert">{form.formState.errors.number.message}</span>
        ) : null}
      </label>
      <label className={labelClass}>
        项目名称
        <Input {...form.register('name')} />
        {form.formState.errors.name ? (
          <span role="alert">{form.formState.errors.name.message}</span>
        ) : null}
      </label>
      <label className={labelClass}>
        客户 ID
        <Input {...form.register('customerId')} />
      </label>
      <label className={labelClass}>
        项目集 ID
        <Input {...form.register('portfolioId')} />
      </label>
      <label className={labelClass}>
        开始日期
        <Input type="date" {...form.register('startDate')} />
      </label>
      <label className={labelClass}>
        结束日期
        <Input type="date" {...form.register('endDate')} />
      </label>
      <label className={labelClass}>
        状态
        <select className={selectClass} {...form.register('status')}>
          {Object.entries(statuses).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        完成进度
        <Input type="number" min="0" max="100" {...form.register('completionPercent')} />
        {form.formState.errors.completionPercent ? (
          <span role="alert">{form.formState.errors.completionPercent.message}</span>
        ) : null}
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        说明
        <textarea
          className="mt-1 min-h-28 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] p-3"
          {...form.register('description')}
        />
      </label>
      {mutation.error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)] sm:col-span-2">
          {mutation.error instanceof ApiError ? mutation.error.message : '保存项目失败'}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button disabled={mutation.isPending}>{mutation.isPending ? '保存中…' : '保存项目'}</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push(`/projects/${encodeURIComponent(project.id)}`)}
        >
          取消
        </Button>
      </div>
    </form>
  );
}

export default function ProjectEditPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const result = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: Boolean(projectId),
  });
  return (
    <AppShell>
      <Link
        className="inline-flex min-h-11 items-center underline"
        href={`/projects/${encodeURIComponent(projectId)}`}
      >
        返回项目详情
      </Link>
      <h1 className="mb-5 text-2xl font-bold">编辑项目</h1>
      {result.isLoading ? <LoadingState title="正在加载项目" /> : null}
      {result.isError ? <ErrorState {...errorCopy(result.error, '项目')} /> : null}
      {result.data && result.data.canManage !== true ? (
        <ErrorState title="你无权维护此项目" description="写入能力仅在服务端明确授权时开放。" />
      ) : null}
      {result.data?.canManage === true ? (
        <Card>
          <CardContent>
            <ProjectForm
              project={
                result.data as ProjectSummary & {
                  status: Exclude<ProjectSummary['status'], 'ARCHIVED'>;
                }
              }
            />
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
