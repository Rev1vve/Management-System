'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { errorCopy } from '@/components/business/resource-list-page';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError, type AdminUserRow } from '@/lib/api';

const PAGE_SIZE = 20;

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: '启用',
  SUSPENDED: '已停用',
  INVITED: '已邀请',
  ARCHIVED: '已归档',
};

/**
 * 用户管理。所有权限都在服务端：页面只负责把拒绝原因如实呈现，
 * 不自作聪明地把"看起来不该允许"的按钮藏起来当授权。
 */
export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['admin', 'users', page, search],
    queryFn: () => api.listAdminUsers({ page, pageSize: PAGE_SIZE, search: search || undefined }),
    retry: false,
  });
  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.listAdminRoles(),
    retry: false,
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: AdminUserRow['status'] }) =>
      api.setUserStatus(input.id, input.status),
    onSuccess: async (_data, input) => {
      // 只有停用/归档会吊销会话；"启用"不会，别宣称做过没做的事。
      setFeedback(
        input.status === 'SUSPENDED'
          ? '已停用，该用户的全部会话已吊销'
          : input.status === 'ARCHIVED'
            ? '已归档，该用户的全部会话已吊销'
            : '已启用，该用户需要重新登录后才能继续使用',
      );
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
  const changeRoles = useMutation({
    mutationFn: (input: { id: string; roles: string[] }) => api.setUserRoles(input.id, input.roles),
    onSuccess: async () => {
      setFeedback('角色已更新，该用户需要重新登录');
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  const mutationError = changeStatus.error ?? changeRoles.error;

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">管理中心</p>
          <h1 className="text-2xl font-semibold text-ink">用户管理</h1>
          <p className="mt-1 text-sm text-muted">
            管理账号状态与系统角色。管理员只有管理权限，不会因此获得业务数据读取权。
          </p>
        </div>
        <label className="text-sm font-medium text-ink">
          搜索
          <Input
            className="mt-1"
            placeholder="账号 / 姓名 / 邮箱"
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
          />
        </label>
      </div>

      {feedback && !mutationError ? (
        <p className="mt-4 text-sm text-success" role="status">
          {feedback}
        </p>
      ) : null}
      {mutationError ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {mutationError instanceof ApiError && mutationError.status < 500
            ? mutationError.message
            : errorCopy(mutationError, '用户管理', '操作').description}
        </p>
      ) : null}

      {query.isPending ? <LoadingState title="正在加载用户" /> : null}
      {query.isError ? (
        <div role="alert">
          <ErrorState
            {...errorCopy(query.error, '用户')}
            action={
              <Button type="button" variant="secondary" onClick={() => query.refetch()}>
                重新加载
              </Button>
            }
          />
        </div>
      ) : null}
      {query.data && query.data.items.length === 0 ? (
        <EmptyState title="没有匹配的用户" description="换一个搜索词，或确认是否已经邀请成员。" />
      ) : null}

      {query.data && query.data.items.length > 0 ? (
        <Card className="mt-6">
          <CardContent>
            <TableContainer>
              <Table>
                <thead>
                  <tr>
                    <TableHead>账号</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>工作邮箱</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>双因素</TableHead>
                    <TableHead>系统角色</TableHead>
                    <TableHead>操作</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((user) => (
                    <tr key={user.id} className="border-t border-border">
                      <TableCell className="font-mono text-xs">{user.account}</TableCell>
                      <TableCell>{user.name}</TableCell>
                      <TableCell>{user.workEmail}</TableCell>
                      <TableCell>{STATUS_LABELS[user.status] ?? user.status}</TableCell>
                      <TableCell>{user.mfaEnabled ? '已启用' : '未启用'}</TableCell>
                      <TableCell>
                        {user.roles.length > 0
                          ? user.roles.map((role) => role.name).join('、')
                          : '无'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() =>
                              changeStatus.mutate({
                                id: user.id,
                                status: user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                              })
                            }
                          >
                            {user.status === 'ACTIVE' ? '停用' : '启用'}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setEditing(user)}
                          >
                            改角色
                          </Button>
                        </div>
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableContainer>
            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-sm text-muted">
                共 {query.data.total} 人，第 {query.data.page} 页
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={page * PAGE_SIZE >= query.data.total}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {editing ? (
        <RoleEditor
          user={editing}
          roles={roles.data ?? []}
          rolesLoading={roles.isPending}
          rolesError={roles.isError}
          pending={changeRoles.isPending}
          onCancel={() => setEditing(null)}
          onSave={(keys) => changeRoles.mutate({ id: editing.id, roles: keys })}
        />
      ) : null}
    </AppShell>
  );
}

function RoleEditor({
  user,
  roles,
  rolesLoading,
  rolesError,
  pending,
  onCancel,
  onSave,
}: {
  user: AdminUserRow;
  roles: Array<{ key: string; name: string; requiresMfa: boolean }>;
  rolesLoading: boolean;
  rolesError: boolean;
  pending: boolean;
  onCancel: () => void;
  onSave: (keys: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(user.roles.map((role) => role.key));
  const toggle = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );

  return (
    <Card className="mt-6">
      <CardContent className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">调整 {user.name} 的系统角色</h2>
        {rolesLoading ? <LoadingState title="正在加载角色" /> : null}
        {rolesError ? (
          <p className="text-sm text-danger" role="alert">
            角色清单加载失败，暂时无法调整。
          </p>
        ) : null}
        <div className="space-y-2">
          {roles.map((role) => (
            <label key={role.key} className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={selected.includes(role.key)}
                onChange={() => toggle(role.key)}
              />
              <span>
                {role.name}
                <span className="ml-2 font-mono text-xs text-muted">{role.key}</span>
                {role.requiresMfa ? (
                  <span className="ml-2 text-xs text-muted">需要双因素认证</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          保存后该用户的会话会被吊销，需要重新登录；未启用双因素的用户不能获得需要 MFA 的角色。
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={pending || rolesLoading || rolesError}
            onClick={() => onSave(selected)}
          >
            {pending ? '正在保存…' : '保存角色'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
