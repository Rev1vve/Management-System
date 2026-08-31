'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ResourceListPage } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
const labels = { ACTIVE: '活跃', INACTIVE: '停用', ARCHIVED: '已归档' } as const;
export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <ResourceListPage
        resource="customers"
        title="客户"
        noun="客户"
        badge="客户工作区"
        description="只显示服务端授权范围内的客户基本信息。"
        statuses={Object.entries(labels).map(([value, label]) => ({ value, label }))}
        query={api.listCustomers}
        columns={[
          { label: '客户编号', render: (x) => x.number },
          { label: '名称', render: (x) => x.name },
          { label: '状态', render: (x) => labels[x.status] },
          { label: '更新时间', render: (x) => new Date(x.updatedAt).toLocaleDateString('zh-CN') },
        ]}
        actions={(data) =>
          data.canManage === true ? (
            <Button asChild>
              <Link href="/customers/new">新建客户</Link>
            </Button>
          ) : null
        }
      />
    </Suspense>
  );
}
