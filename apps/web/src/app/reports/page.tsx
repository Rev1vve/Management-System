import { WorkspacePage } from '@/components/layout/workspace-page';

export default function ReportsPage() {
  return (
    <WorkspacePage
      title="报表"
      description="汇总项目、工时与审批趋势；管理员身份不会自动获得业务报表读取权。"
      columns={['报表', '范围', '时间区间', '更新时间', '状态']}
      actionLabel="导出报表"
    />
  );
}
