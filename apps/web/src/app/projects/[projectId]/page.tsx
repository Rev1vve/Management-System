'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AppShell } from '@/components/layout/app-shell';
import { errorCopy } from '@/components/business/resource-list-page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError, ProjectMember } from '@/lib/api';
const roleLabels = {
  PROJECT_MANAGER: '项目经理',
  MEMBER: '成员',
  APPROVER: '审批人',
  OBSERVER: '观察者',
} as const;
const memberSchema = z.object({
  userId: z.string().trim().min(1, '请输入用户 ID'),
  role: z.enum(['PROJECT_MANAGER', 'MEMBER', 'APPROVER', 'OBSERVER']),
});
type MV = z.infer<typeof memberSchema>;
function MemberForm({ projectId, close }: { projectId: string; close: () => void }) {
  const qc = useQueryClient();
  const f = useForm<MV>({
    resolver: zodResolver(memberSchema),
    defaultValues: { userId: '', role: 'MEMBER' },
  });
  const m = useMutation({
    mutationFn: (v: MV) => api.addProjectMember(projectId, { userId: v.userId, roles: [v.role] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      close();
    },
  });
  return (
    <form
      noValidate
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={f.handleSubmit((v) => m.mutate(v))}
    >
      <label className="text-sm">
        用户 ID
        <Input {...f.register('userId')} />
        {f.formState.errors.userId ? (
          <span role="alert">{f.formState.errors.userId.message}</span>
        ) : null}
      </label>
      <label className="text-sm">
        项目角色
        <select
          aria-label="项目角色"
          className="mt-1 h-11 w-full rounded border px-3"
          {...f.register('role')}
        >
          {Object.entries(roleLabels).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-2">
        <Button disabled={m.isPending}>保存成员</Button>
        <Button type="button" variant="secondary" onClick={close}>
          取消
        </Button>
      </div>
      {m.error ? (
        <p role="alert" className="sm:col-span-3">
          {m.error instanceof ApiError ? m.error.message : '保存失败'}
        </p>
      ) : null}
    </form>
  );
}
function Members({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.listProjectMembers(projectId),
  });
  const remove = useMutation({
    mutationFn: (u: string) => api.removeProjectMember(projectId, u),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', projectId] }),
  });
  const update = useMutation({
    mutationFn: ({ u, r }: { u: string; r: ProjectMember['roles'][number]['role'] }) =>
      api.updateProjectMember(projectId, u, { roles: [r] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', projectId] }),
  });
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">项目成员</h2>
        {canManage ? <Button onClick={() => setAdding(true)}>添加成员</Button> : null}
      </div>
      {adding ? <MemberForm projectId={projectId} close={() => setAdding(false)} /> : null}
      {q.isLoading ? <LoadingState title="正在加载项目成员" /> : null}
      {q.isError ? <ErrorState {...errorCopy(q.error, '项目成员')} /> : null}
      {q.data?.length === 0 ? (
        <EmptyState title="暂无项目成员" description="服务端返回的成员会显示在这里。" />
      ) : null}
      {q.data && q.data.length > 0 ? (
        <TableContainer>
          <Table aria-label="项目成员列表">
            <thead>
              <tr>
                <TableHead>姓名</TableHead>
                <TableHead>工作邮箱</TableHead>
                <TableHead>角色</TableHead>
                {canManage ? <TableHead>操作</TableHead> : null}
              </tr>
            </thead>
            <tbody>
              {q.data.map((x) => (
                <tr key={x.id}>
                  <TableCell>{x.user.name}</TableCell>
                  <TableCell>{x.user.workEmail}</TableCell>
                  <TableCell>
                    {canManage ? (
                      <select
                        aria-label={`修改 ${x.user.name} 角色`}
                        className="h-11 rounded border px-2"
                        value={x.roles[0]?.role ?? 'MEMBER'}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({
                            u: x.userId,
                            r: e.target.value as ProjectMember['roles'][number]['role'],
                          })
                        }
                      >
                        {Object.entries(roleLabels).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      x.roles.map((r) => roleLabels[r.role]).join('、')
                    )}
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <Button
                        variant="danger"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(x.userId)}
                      >
                        移除成员
                      </Button>
                    </TableCell>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      ) : null}
      {remove.error || update.error ? (
        <p role="alert">
          {(remove.error ?? update.error) instanceof ApiError
            ? (remove.error ?? (update.error as ApiError)).message
            : '成员维护失败'}
        </p>
      ) : null}
    </section>
  );
}
export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: Boolean(projectId),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveProject(projectId, { version: q.data!.version }),
    onSuccess: () => router.push('/projects'),
  });
  return (
    <AppShell>
      <Link className="inline-flex min-h-11 items-center underline" href="/projects">
        返回项目列表
      </Link>
      {q.isLoading ? <LoadingState title="正在加载项目" /> : null}
      {q.isError ? <ErrorState {...errorCopy(q.error, '项目')} /> : null}
      {q.data ? (
        <div className="space-y-5">
          <header className="flex flex-wrap justify-between gap-3">
            <div>
              <p className="text-sm text-[var(--color-muted)]">{q.data.number}</p>
              <h1 className="text-2xl font-bold">{q.data.name}</h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href={`/orders?projectId=${encodeURIComponent(projectId)}`}>进入订单</Link>
              </Button>
              {q.data.canManage === true ? (
                <>
                  <Button asChild variant="secondary">
                    <Link href={`/projects/${encodeURIComponent(projectId)}/edit`}>编辑项目</Link>
                  </Button>
                  <Button variant="danger" onClick={() => setConfirm(true)}>
                    归档项目
                  </Button>
                </>
              ) : null}
            </div>
          </header>
          {confirm ? (
            <Card>
              <CardContent className="space-y-3">
                <p>确认归档此项目？</p>
                {archive.error ? (
                  <p role="alert">
                    {archive.error instanceof ApiError ? archive.error.message : '归档失败'}
                  </p>
                ) : null}
                <Button
                  variant="danger"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate()}
                >
                  确认归档
                </Button>
                <Button variant="secondary" onClick={() => setConfirm(false)}>
                  取消
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <h2 className="font-semibold">基本信息</h2>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt>状态</dt>
                  <dd>{q.data.status}</dd>
                </div>
                <div>
                  <dt>完成进度</dt>
                  <dd>{q.data.completionPercent}%</dd>
                </div>
                {q.data.customer ? (
                  <div>
                    <dt>客户</dt>
                    <dd>{q.data.customer.name}</dd>
                  </div>
                ) : null}
                {q.data.portfolio ? (
                  <div>
                    <dt>项目集</dt>
                    <dd>{q.data.portfolio.name}</dd>
                  </div>
                ) : null}
                {q.data.description !== undefined ? (
                  <div>
                    <dt>说明</dt>
                    <dd>{q.data.description || '—'}</dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Members projectId={projectId} canManage={q.data.canManage === true} />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
