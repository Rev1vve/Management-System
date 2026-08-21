import { WorkspacePage } from '@/components/layout/workspace-page';

export default function WorklogsPage() {
  return (
    <WorkspacePage
      title="工作日志"
      description="记录工作内容与工时，并提交单级审批。"
      columns={['日期', '项目', '工作内容', '工时', '审批状态']}
      actionLabel="记录工作日志"
    />
  );
}
