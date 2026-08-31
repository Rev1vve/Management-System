'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ResourceListPage } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

const labels = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  ARCHIVED: '已归档',
} as const;

function OrdersContent() {
  const projectId = useSearchParams().get('projectId')?.trim();

  if (!projectId) {
    return (
      <section className="space-y-4" aria-labelledby="orders-title">
        <div>
          <p className="text-sm font-medium text-primary">订单工作区</p>
          <h1 id="orders-title" className="text-2xl font-semibold tracking-tight">
            订单
          </h1>
        </div>
        <div className="rounded-xl border bg-card p-6">
          <h2 className="font-semibold">请先从项目详情进入订单</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            订单必须在明确的项目作用域内读取，当前页面不会发起无项目范围的请求。
          </p>
        </div>
      </section>
    );
  }

  return (
    <ResourceListPage
      resource={`projects/${projectId}/orders`}
      title="订单"
      noun="订单"
      badge="订单工作区"
      description="查看所属项目内的订单；不展示服务端未返回的金额或指标。"
      statuses={Object.entries(labels).map(([value, label]) => ({ value, label }))}
      query={(query) => api.listOrders(projectId, query)}
      columns={[
        { label: '订单编号', render: (item) => item.number },
        { label: '名称', render: (item) => item.title },
        { label: '所属项目', render: (item) => item.projectId },
        { label: '状态', render: (item) => labels[item.status] },
        {
          label: '更新时间',
          render: (item) => new Date(item.updatedAt).toLocaleDateString('zh-CN'),
        },
      ]}
      actions={(data) =>
        data.canManage === true ? (
          <Button asChild>
            <Link href={`/projects/${encodeURIComponent(projectId)}/orders/new`}>新建订单</Link>
          </Button>
        ) : null
      }
    />
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={null}>
      <OrdersContent />
    </Suspense>
  );
}
