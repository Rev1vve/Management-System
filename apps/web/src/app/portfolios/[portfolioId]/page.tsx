'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AppShell } from '@/components/layout/app-shell';
import { errorCopy } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { api, ApiError, PortfolioSummary } from '@/lib/api';
const schema = z.object({
  name: z.string().trim().min(1, '请输入项目集名称').max(200),
  description: z.string().max(2000),
  status: z.literal('ACTIVE'),
});
type Values = z.infer<typeof schema>;
function Form({
  value,
  close,
}: {
  value: PortfolioSummary & { status: 'ACTIVE' };
  close: () => void;
}) {
  const qc = useQueryClient();
  const f = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: value.name, description: value.description ?? '', status: 'ACTIVE' },
  });
  useEffect(
    () => f.reset({ name: value.name, description: value.description ?? '', status: 'ACTIVE' }),
    [f, value],
  );
  const m = useMutation({
    mutationFn: (v: Values) =>
      api.updatePortfolio(value.id, {
        name: v.name,
        description: v.description || null,
        status: v.status,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['portfolio', value.id] });
      close();
    },
  });
  return (
    <form
      noValidate
      aria-label="编辑项目集表单"
      className="space-y-4"
      onSubmit={f.handleSubmit((v) => m.mutate(v))}
    >
      <label className="block text-sm">
        项目集名称
        <Input {...f.register('name')} />
        {f.formState.errors.name ? (
          <span role="alert">{f.formState.errors.name.message}</span>
        ) : null}
      </label>
      <label className="block text-sm">
        说明
        <textarea
          className="mt-1 min-h-24 w-full rounded border p-3"
          {...f.register('description')}
        />
      </label>
      <label className="block text-sm">
        状态
        <select className="mt-1 h-11 w-full rounded border px-3" {...f.register('status')}>
          <option value="ACTIVE">活跃</option>
        </select>
      </label>
      {m.error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {m.error instanceof ApiError ? m.error.message : '保存失败'}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={m.isPending}>保存项目集</Button>
        <Button type="button" variant="secondary" onClick={close}>
          取消
        </Button>
      </div>
    </form>
  );
}
export default function PortfolioDetailPage() {
  const { portfolioId } = useParams<{ portfolioId: string }>();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({
    queryKey: ['portfolio', portfolioId],
    queryFn: () => api.getPortfolio(portfolioId),
    enabled: Boolean(portfolioId),
  });
  const archive = useMutation({
    mutationFn: () => api.archivePortfolio(portfolioId),
    onSuccess: () => router.push('/portfolios'),
  });
  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href="/portfolios">
        返回项目集列表
      </Link>
      {q.isLoading ? <LoadingState title="正在加载项目集" /> : null}
      {q.isError ? <ErrorState {...errorCopy(q.error, '项目集')} /> : null}
      {q.data ? (
        <div className="space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-[var(--color-muted)]">项目集详情</p>
              <h1 className="text-2xl font-bold">{q.data.name}</h1>
            </div>
            {q.data.canManage === true && q.data.status !== 'ARCHIVED' ? (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  编辑项目集
                </Button>
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  归档项目集
                </Button>
              </div>
            ) : null}
          </header>
          {confirm ? (
            <Card>
              <CardContent className="space-y-3">
                <p>确认归档此项目集？</p>
                {archive.error ? (
                  <p role="alert">
                    {archive.error instanceof ApiError ? archive.error.message : '归档失败'}
                  </p>
                ) : null}
                <Button
                  variant="danger"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate()}
                >
                  确认归档
                </Button>
                <Button variant="secondary" onClick={() => setConfirm(false)}>
                  取消
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardContent>
              {editing ? (
                <Form
                  value={q.data as PortfolioSummary & { status: 'ACTIVE' }}
                  close={() => setEditing(false)}
                />
              ) : (
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-[var(--color-muted)]">说明</dt>
                    <dd>{q.data.description || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-[var(--color-muted)]">状态</dt>
                    <dd>{q.data.status === 'ACTIVE' ? '活跃' : '已归档'}</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
