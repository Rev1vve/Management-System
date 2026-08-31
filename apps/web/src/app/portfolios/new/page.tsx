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
  name: z.string().trim().min(1, '请输入项目集名称').max(200),
  description: z.string().max(2000),
});
type Values = z.infer<typeof schema>;

export default function PortfolioCreatePage() {
  const router = useRouter();
  const capability = useQuery({
    queryKey: ['portfolios', 'create-capability'],
    queryFn: () => api.listPortfolios({ page: 1, pageSize: 1, search: '' }),
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '' },
  });
  const mutation = useMutation({
    mutationFn: (values: Values) =>
      api.createPortfolio({ name: values.name, description: values.description || null }),
    onSuccess: (portfolio) => router.push(`/portfolios/${encodeURIComponent(portfolio.id)}`),
  });

  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href="/portfolios">
        返回项目集列表
      </Link>
      <h1 className="mb-5 text-2xl font-bold">新建项目集</h1>
      {capability.isLoading ? <LoadingState title="正在核验项目集创建权限" /> : null}
      {capability.isError ? (
        <ErrorState {...errorCopy(capability.error, '项目集创建权限')} />
      ) : null}
      {capability.data && capability.data.canManage !== true ? (
        <ErrorState title="你无权新建项目集" description="写入能力仅在服务端明确授权时开放。" />
      ) : null}
      {capability.data?.canManage === true ? (
        <Card>
          <CardContent>
            <form
              noValidate
              className="space-y-4"
              onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            >
              <label className="block text-sm font-medium">
                项目集名称
                <Input {...form.register('name')} />
                {form.formState.errors.name ? (
                  <span role="alert">{form.formState.errors.name.message}</span>
                ) : null}
              </label>
              <label className="block text-sm font-medium">
                说明
                <textarea
                  className="mt-1 min-h-28 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] p-3"
                  {...form.register('description')}
                />
              </label>
              {mutation.error ? (
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  {mutation.error instanceof ApiError ? mutation.error.message : '创建项目集失败'}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button disabled={mutation.isPending}>
                  {mutation.isPending ? '创建中…' : '创建项目集'}
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/portfolios">取消</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
