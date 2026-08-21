import { WorkspacePage } from '@/components/layout/workspace-page';

export default function SettingsPage() {
  return (
    <WorkspacePage
      title="系统设置"
      description="管理仅限系统级的配置，不提供业务数据浏览入口。"
      columns={['设置项', '说明', '状态', '更新时间']}
      actionLabel="修改设置"
    />
  );
}
