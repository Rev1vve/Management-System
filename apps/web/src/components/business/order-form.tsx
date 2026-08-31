'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError, OrderSummary } from '@/lib/api';

const schema = z
  .object({
    number: z.string().trim().min(1, '请输入订单编号').max(100),
    title: z.string().trim().min(1, '请输入订单名称').max(200),
    description: z.string().max(4000),
    startDate: z.string(),
    deliveryDate: z.string(),
    status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']),
  })
  .refine(
    ({ startDate, deliveryDate }) => !startDate || !deliveryDate || startDate <= deliveryDate,
    {
      message: '开始日期不能晚于交付日期',
      path: ['deliveryDate'],
    },
  );
type Values = z.infer<typeof schema>;
const statuses = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
} as const;
const dateValue = (value?: string | null) => (value ? value.slice(0, 10) : '');
const formStatus = (value?: OrderSummary['status']): Values['status'] =>
  value && value !== 'ARCHIVED' ? value : 'DRAFT';

export function OrderForm({ projectId, order }: { projectId: string; order?: OrderSummary }) {
  const router = useRouter();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      number: order?.number ?? '',
      title: order?.title ?? '',
      description: order?.description ?? '',
      startDate: dateValue(order?.startDate),
      deliveryDate: dateValue(order?.deliveryDate),
      status: formStatus(order?.status),
    },
  });
  useEffect(
    () =>
      form.reset({
        number: order?.number ?? '',
        title: order?.title ?? '',
        description: order?.description ?? '',
        startDate: dateValue(order?.startDate),
        deliveryDate: dateValue(order?.deliveryDate),
        status: formStatus(order?.status),
      }),
    [form, order],
  );
  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const common = {
        number: values.number,
        title: values.title,
        description: values.description || null,
        startDate: values.startDate || null,
        deliveryDate: values.deliveryDate || null,
      };
      return order
        ? api.updateOrder(projectId, order.id, {
            ...common,
            status: values.status,
            version: order.version,
          })
        : api.createOrder(projectId, { ...common, status: 'DRAFT' });
    },
    onSuccess: (value) =>
      router.push(
        `/projects/${encodeURIComponent(projectId)}/orders/${encodeURIComponent(value.id)}`,
      ),
  });
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <label className="block text-sm font-medium">
        订单编号
        <Input {...form.register('number')} />
        {form.formState.errors.number ? (
          <span role="alert">{form.formState.errors.number.message}</span>
        ) : null}
      </label>
      <label className="block text-sm font-medium">
        订单名称
        <Input {...form.register('title')} />
        {form.formState.errors.title ? (
          <span role="alert">{form.formState.errors.title.message}</span>
        ) : null}
      </label>
      <label className="block text-sm font-medium">
        开始日期
        <Input type="date" {...form.register('startDate')} />
      </label>
      <label className="block text-sm font-medium">
        交付日期
        <Input type="date" {...form.register('deliveryDate')} />
      </label>
      {order ? (
        <label className="block text-sm font-medium">
          状态
          <select
            className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3"
            {...form.register('status')}
          >
            {Object.entries(statuses).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="self-end pb-3 text-sm font-medium">初始状态：草稿</p>
      )}
      <label className="block text-sm font-medium sm:col-span-2">
        说明
        <textarea
          className="mt-1 min-h-28 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] p-3"
          {...form.register('description')}
        />
      </label>
      {mutation.error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)] sm:col-span-2">
          {mutation.error instanceof ApiError ? mutation.error.message : '保存订单失败'}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button disabled={mutation.isPending}>
          {mutation.isPending ? '保存中…' : order ? '保存订单' : '创建订单'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            router.push(
              order
                ? `/projects/${encodeURIComponent(projectId)}/orders/${encodeURIComponent(order.id)}`
                : `/orders?projectId=${encodeURIComponent(projectId)}`,
            )
          }
        >
          取消
        </Button>
      </div>
    </form>
  );
}
