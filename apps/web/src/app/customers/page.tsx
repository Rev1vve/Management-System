import { WorkspacePage } from '@/components/layout/workspace-page';

export default function CustomersPage() {
  return (
    <WorkspacePage
      title="客户"
      description="管理客户组织、联系人与合同附件的入口。"
      columns={['客户编号', '名称', '主要联系人', '状态', '更新时间']}
      actionLabel="新建客户"
    />
  );
}
