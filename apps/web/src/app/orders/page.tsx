import { WorkspacePage } from '@/components/layout/workspace-page';

export default function OrdersPage() {
  return (
    <WorkspacePage
      title="订单"
      description="查看项目下的订单与订单明细，不包含金额、发票或成本。"
      columns={['订单编号', '名称', '所属项目', '明细数', '状态', '更新时间']}
      actionLabel="新建订单"
    />
  );
}
