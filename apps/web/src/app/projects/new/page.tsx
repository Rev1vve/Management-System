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
  number: z.string().trim().min(1, '请输入项目编号').max(100),
  name: z.string().trim().min(1, '请输入项目名称').max(200),
  customerId: z.string().trim().max(100),
  portfolioId: z.string().trim().max(100),
});
type Values = z.infer<typeof schema>;

export default function ProjectCreatePage() {
  const router = useRouter();
  const capability = useQuery({
    queryKey: ['projects', 'create-capability'],
    queryFn: () => api.listProjects({ page: 1, pageSize: 1, search: '', status: '' }),
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { number: '', name: '', customerId: '', portfolioId: '' },
  });
  const mutation = useMutation({
    mutationFn: (values: Values) =>
      api.createProject({
        number: values.number,
        name: values.name,
        customerId: values.customerId || null,
        portfolioId: values.portfolioId || null,
      }),
    onSuccess: (project) => router.push(`/projects/${encodeURIComponent(project.id)}`),
  });

  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href="/projects">
        返回项目列表
      </Link>
      <h1 className="mb-5 text-2xl font-bold">新建项目</h1>
      {capability.isLoading ? <LoadingState title="正在核验项目创建权限" /> : null}
      {capability.isError ? <ErrorState {...errorCopy(capability.error, '项目创建权限')} /> : null}
      {capability.data && capability.data.canManage !== true ? (
        <ErrorState title="你无权新建项目" description="写入能力仅在服务端明确授权时开放。" />
      ) : null}
      {capability.data?.canManage === true ? (
        <Card>
          <CardContent>
            <form
              noValidate
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            >
              <label className="block text-sm font-medium">
                项目编号
                <Input {...form.register('number')} />
                {form.formState.errors.number ? (
                  <span role="alert">{form.formState.errors.number.message}</span>
                ) : null}
              </label>
              <label className="block text-sm font-medium">
                项目名称
                <Input {...form.register('name')} />
                {form.formState.errors.name ? (
                  <span role="alert">{form.formState.errors.name.message}</span>
                ) : null}
              </label>
              <label className="block text-sm font-medium">
                客户 ID
                <Input {...form.register('customerId')} />
              </label>
              <label className="block text-sm font-medium">
                项目集 ID
                <Input {...form.register('portfolioId')} />
              </label>
              {mutation.error ? (
                <p role="alert" className="text-sm text-[var(--color-danger)] sm:col-span-2">
                  {mutation.error instanceof ApiError ? mutation.error.message : '创建项目失败'}
                </p>
              ) : null}
              <div className="flex gap-2 sm:col-span-2">
                <Button disabled={mutation.isPending}>
                  {mutation.isPending ? '创建中…' : '创建项目'}
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/projects">取消</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
