'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { errorCopy } from '@/components/business/resource-list-page';
import { OrderForm } from '@/components/business/order-form';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { api } from '@/lib/api';

export default function OrderEditPage() {
  const { projectId, orderId } = useParams<{ projectId: string; orderId: string }>();
  const result = useQuery({
    queryKey: ['order', projectId, orderId],
    queryFn: () => api.getOrder(projectId, orderId),
    enabled: Boolean(projectId && orderId),
  });
  const detailHref = `/projects/${encodeURIComponent(projectId)}/orders/${encodeURIComponent(orderId)}`;
  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href={detailHref}>
        返回订单详情
      </Link>
      <h1 className="mb-5 text-2xl font-bold">编辑订单</h1>
      {result.isLoading ? <LoadingState title="正在加载订单" /> : null}
      {result.isError ? <ErrorState {...errorCopy(result.error, '订单')} /> : null}
      {result.data && result.data.canManage !== true ? (
        <ErrorState title="你无权维护此订单" description="写入能力仅在服务端明确授权时开放。" />
      ) : null}
      {result.data?.canManage === true ? (
        <Card>
          <CardContent>
            <OrderForm projectId={projectId} order={result.data} />
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
