'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ResourceListPage } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
const labels = { ACTIVE: '活跃', ARCHIVED: '已归档' } as const;
export default function PortfoliosPage() {
  return (
    <Suspense fallback={null}>
      <ResourceListPage
        resource="portfolios"
        title="项目集"
        noun="项目集"
        badge="项目集工作区"
        description="只显示服务端项目集成员范围内的信息。"
        statuses={Object.entries(labels).map(([value, label]) => ({ value, label }))}
        query={api.listPortfolios}
        columns={[
          { label: '名称', render: (x) => x.name },
          { label: '说明', render: (x) => x.description ?? '—' },
          { label: '状态', render: (x) => labels[x.status] },
          { label: '更新时间', render: (x) => new Date(x.updatedAt).toLocaleDateString('zh-CN') },
        ]}
        actions={(data) =>
          data.canManage === true ? (
            <Button asChild>
              <Link href="/portfolios/new">新建项目集</Link>
            </Button>
          ) : null
        }
      />
    </Suspense>
  );
}
