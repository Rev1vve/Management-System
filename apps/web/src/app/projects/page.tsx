'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ResourceListPage } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
const labels = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  ON_HOLD: '暂停',
  COMPLETED: '已完成',
  ARCHIVED: '已归档',
} as const;
export default function ProjectsPage() {
  return (
    <Suspense fallback={null}>
      <ResourceListPage
        resource="projects"
        title="项目"
        noun="项目"
        badge="项目工作区"
        description="查看你所属项目的基础字段；访问范围由服务端成员关系决定。"
        statuses={Object.entries(labels).map(([value, label]) => ({ value, label }))}
        query={api.listProjects}
        columns={[
          { label: '项目编号', render: (x) => x.number, className: 'font-mono text-xs' },
          { label: '名称', render: (x) => x.name },
          { label: '客户', render: (x) => x.customer?.name ?? '未关联' },
          { label: '项目集', render: (x) => x.portfolio?.name ?? '未归入项目集' },
          { label: '状态', render: (x) => labels[x.status] },
          { label: '完成进度', render: (x) => `${x.completionPercent}%` },
        ]}
        actions={(data) =>
          data.canManage === true ? (
            <Button asChild>
              <Link href="/projects/new">新建项目</Link>
            </Button>
          ) : null
        }
      />
    </Suspense>
  );
}
