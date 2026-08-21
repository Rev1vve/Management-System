import { WorkspacePage } from '@/components/layout/workspace-page';

export default function ApprovalsPage() {
  return (
    <WorkspacePage
      title="审批"
      description="处理已提交的工作日志；审批人不能审批自己的提交。"
      columns={['提交人', '项目', '周期', '工时', '提交时间', '状态']}
      actionLabel="批量处理"
    />
  );
}
