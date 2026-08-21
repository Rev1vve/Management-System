import { WorkspacePage } from '@/components/layout/workspace-page';

export default function ProjectsPage() {
  return (
    <WorkspacePage
      title="项目"
      description="查看项目状态、成员与所属客户；数据访问将受项目成员作用域约束。"
      columns={['项目编号', '名称', '客户', '项目经理', '状态', '更新时间']}
      actionLabel="新建项目"
    />
  );
}
