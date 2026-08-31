'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AppShell } from '@/components/layout/app-shell';
import { errorCopy } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError, OrderItem } from '@/lib/api';
const labels = {
  PENDING: '待处理',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
} as const;
const schema = z.object({
  name: z.string().trim().min(1, '请输入明细名称'),
  quantity: z.number().nonnegative('数量必须为非负数'),
  unit: z.string().max(50),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  sortOrder: z.number().int().nonnegative(),
});
type V = z.infer<typeof schema>;
function ItemForm({
  projectId,
  orderId,
  version,
  item,
  close,
}: {
  projectId: string;
  orderId: string;
  version: number;
  item?: OrderItem;
  close: () => void;
}) {
  const qc = useQueryClient();
  const f = useForm<V>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: item?.name ?? '',
      quantity: Number(item?.quantity ?? 1),
      unit: item?.unit ?? '',
      status: item?.status ?? 'PENDING',
      sortOrder: item?.sortOrder ?? 0,
    },
  });
  const m = useMutation({
    mutationFn: (v: V) => {
      const body = { ...v, version, unit: v.unit || null };
      return item
        ? api.updateOrderItem(projectId, orderId, item.id, body)
        : api.createOrderItem(projectId, orderId, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['order', projectId, orderId] });
      qc.invalidateQueries({ queryKey: ['order-items', projectId, orderId] });
      close();
    },
  });
  return (
    <form
      noValidate
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={f.handleSubmit((v) => m.mutate(v))}
    >
      <label className="text-sm">
        明细名称
        <Input {...f.register('name')} />
        {f.formState.errors.name ? (
          <span role="alert">{f.formState.errors.name.message}</span>
        ) : null}
      </label>
      <label className="text-sm">
        数量
        <Input
          type="number"
          min="0"
          step="any"
          {...f.register('quantity', { valueAsNumber: true })}
        />
      </label>
      <label className="text-sm">
        单位
        <Input {...f.register('unit')} />
      </label>
      <label className="text-sm">
        状态
        <select className="mt-1 h-11 w-full rounded border px-3" {...f.register('status')}>
          {Object.entries(labels).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        排序
        <Input type="number" min="0" {...f.register('sortOrder', { valueAsNumber: true })} />
      </label>
      <div className="flex items-end gap-2">
        <Button disabled={m.isPending}>保存明细</Button>
        <Button type="button" variant="secondary" onClick={close}>
          取消
        </Button>
      </div>
      {m.error ? (
        <p role="alert" className="sm:col-span-2">
          {m.error instanceof ApiError ? m.error.message : '保存失败'}
        </p>
      ) : null}
    </form>
  );
}
function Items({
  projectId,
  orderId,
  version,
  canManage,
}: {
  projectId: string;
  orderId: string;
  version: number;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<OrderItem | null | undefined>(undefined);
  const q = useQuery({
    queryKey: ['order-items', projectId, orderId],
    queryFn: () => api.listOrderItems(projectId, orderId),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.archiveOrderItem(projectId, orderId, id, { version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['order', projectId, orderId] });
      qc.invalidateQueries({ queryKey: ['order-items', projectId, orderId] });
    },
  });
  return (
    <section className="space-y-4">
      <div className="flex justify-between gap-3">
        <h2 className="text-lg font-semibold">订单明细</h2>
        {canManage ? <Button onClick={() => setEdit(null)}>新增明细</Button> : null}
      </div>
      {edit !== undefined ? (
        edit === null ? (
          <ItemForm
            projectId={projectId}
            orderId={orderId}
            version={version}
            close={() => setEdit(undefined)}
          />
        ) : (
          <ItemForm
            projectId={projectId}
            orderId={orderId}
            version={version}
            item={edit}
            close={() => setEdit(undefined)}
          />
        )
      ) : null}
      {q.isLoading ? <LoadingState title="正在加载订单明细" /> : null}
      {q.isError ? <ErrorState {...errorCopy(q.error, '订单明细')} /> : null}
      {q.data?.length === 0 ? (
        <EmptyState title="暂无订单明细" description="服务端返回的订单明细会显示在这里。" />
      ) : null}
      {q.data && q.data.length > 0 ? (
        <TableContainer>
          <Table aria-label="订单明细列表">
            <thead>
              <tr>
                <TableHead>名称</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>状态</TableHead>
                {canManage ? <TableHead>操作</TableHead> : null}
              </tr>
            </thead>
            <tbody>
              {q.data.map((x) => (
                <tr key={x.id}>
                  <TableCell>{x.name}</TableCell>
                  <TableCell>
                    {String(x.quantity)} {x.unit ?? ''}
                  </TableCell>
                  <TableCell>{labels[x.status]}</TableCell>
                  {canManage ? (
                    <TableCell>
                      {x.status === 'CANCELLED' ? (
                        <span className="text-sm text-[var(--color-muted)]">已取消</span>
                      ) : (
                        <div className="flex gap-2">
                          <Button variant="secondary" onClick={() => setEdit(x)}>
                            编辑明细
                          </Button>
                          <Button
                            variant="danger"
                            disabled={archive.isPending}
                            onClick={() => archive.mutate(x.id)}
                          >
                            归档明细
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      ) : null}
      {archive.error ? (
        <p role="alert">{archive.error instanceof ApiError ? archive.error.message : '归档失败'}</p>
      ) : null}
    </section>
  );
}
export default function OrderDetailPage() {
  const { projectId, orderId } = useParams<{ projectId: string; orderId: string }>();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({
    queryKey: ['order', projectId, orderId],
    queryFn: () => api.getOrder(projectId, orderId),
    enabled: Boolean(projectId && orderId),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveOrder(projectId, orderId, { version: q.data!.version }),
    onSuccess: () => router.push(`/orders?projectId=${encodeURIComponent(projectId)}`),
  });
  return (
    <AppShell>
      <Link
        className="inline-flex min-h-11 items-center underline"
        href={`/orders?projectId=${encodeURIComponent(projectId)}`}
      >
        返回订单列表
      </Link>
      {q.isLoading ? <LoadingState title="正在加载订单" /> : null}
      {q.isError ? <ErrorState {...errorCopy(q.error, '订单')} /> : null}
      {q.data ? (
        <div className="space-y-5">
          <header className="flex flex-wrap justify-between gap-3">
            <div>
              <p className="text-sm text-[var(--color-muted)]">{q.data.number}</p>
              <h1 className="text-2xl font-bold">{q.data.title}</h1>
            </div>
            {q.data.canManage === true ? (
              <div className="flex gap-2">
                <Button asChild variant="secondary">
                  <Link
                    href={`/projects/${encodeURIComponent(projectId)}/orders/${encodeURIComponent(orderId)}/edit`}
                  >
                    编辑订单
                  </Link>
                </Button>
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  归档订单
                </Button>
              </div>
            ) : null}
          </header>
          {confirm ? (
            <Card>
              <CardContent className="space-y-3">
                <p>确认归档此订单？</p>
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
            <CardHeader>
              <h2 className="font-semibold">基本信息</h2>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt>状态</dt>
                  <dd>{q.data.status}</dd>
                </div>
                {q.data.description !== undefined ? (
                  <div>
                    <dt>说明</dt>
                    <dd>{q.data.description || '—'}</dd>
                  </div>
                ) : null}
                {q.data.startDate ? (
                  <div>
                    <dt>开始日期</dt>
                    <dd>{new Date(q.data.startDate).toLocaleDateString('zh-CN')}</dd>
                  </div>
                ) : null}
                {q.data.deliveryDate ? (
                  <div>
                    <dt>交付日期</dt>
                    <dd>{new Date(q.data.deliveryDate).toLocaleDateString('zh-CN')}</dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Items
                projectId={projectId}
                orderId={orderId}
                version={q.data.version}
                canManage={q.data.canManage === true}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
