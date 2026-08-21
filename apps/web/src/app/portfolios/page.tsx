import { WorkspacePage } from '@/components/layout/workspace-page';

export default function PortfoliosPage() {
  return (
    <WorkspacePage
      title="项目集"
      description="按项目集汇总关联项目，并为项目总监提供一致的查看入口。"
      columns={['项目集编号', '名称', '负责人', '项目数', '状态']}
      actionLabel="新建项目集"
    />
  );
}
