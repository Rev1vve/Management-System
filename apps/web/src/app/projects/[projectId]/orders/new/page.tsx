'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { OrderForm } from '@/components/business/order-form';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { errorCopy } from '@/components/business/resource-list-page';
import { api } from '@/lib/api';

export default function OrderCreatePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: Boolean(projectId),
  });
  return (
    <AppShell>
      <Link
        className="inline-flex min-h-11 items-center underline"
        href={`/orders?projectId=${encodeURIComponent(projectId)}`}
      >
        返回订单列表
      </Link>
      <h1 className="mb-5 text-2xl font-bold">新建订单</h1>
      {project.isLoading ? <LoadingState title="正在确认项目权限" /> : null}
      {project.isError ? <ErrorState {...errorCopy(project.error, '项目')} /> : null}
      {project.data?.canManage === true ? (
        <Card>
          <CardContent>
            <OrderForm projectId={projectId} />
          </CardContent>
        </Card>
      ) : null}
      {project.data && project.data.canManage !== true ? (
        <ErrorState
          title="你无权在此项目中新建订单"
          description="只有服务端明确授权的项目经理可以创建订单。"
        />
      ) : null}
    </AppShell>
  );
}
