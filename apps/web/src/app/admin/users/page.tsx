import { WorkspacePage } from '@/components/layout/workspace-page';

export default function UsersPage() {
  return (
    <WorkspacePage
      title="用户管理"
      description="邀请内部用户并管理系统角色；业务数据权限仍由项目成员关系决定。"
      columns={['账号', '姓名', '工作邮箱', '系统角色', 'MFA', '状态']}
      actionLabel="邀请用户"
    />
  );
}
