import { Clock3, Database, ShieldCheck } from 'lucide-react';

import { AppShell } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';

export default function HomePage() {
  return (
    <AppShell>
      <header className="mb-6">
        <Badge variant="info">内部工作区</Badge>
        <h1 className="mt-3 text-2xl font-bold tracking-[-0.01em] text-[var(--color-navy)] sm:text-[28px]">
          工作台
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-muted)]">
          查看需要关注的项目与运营事项。
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-[var(--color-text)]">我的待办</h2>
              <p className="mt-1 text-sm text-[var(--color-muted)]">需要你处理的审批与工作日志</p>
            </div>
            <Badge variant="neutral">暂未开放</Badge>
          </CardHeader>
          <CardContent>
            <EmptyState
              title="待办功能暂未开放"
              description="相关工作区功能启用后，这里会显示需要你处理的事项。"
              className="py-8"
            />
          </CardContent>
        </Card>

        <aside aria-label="环境信息">
          <Card>
            <CardHeader>
              <h2 className="font-semibold text-[var(--color-text)]">环境信息</h2>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex items-start gap-3">
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]"
                />
                <div>
                  <p className="font-semibold">私网访问</p>
                  <p className="mt-1 leading-5 text-[var(--color-muted)]">
                    服务仅通过受控私网访问。
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Clock3
                  aria-hidden="true"
                  className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-info)]"
                />
                <div>
                  <p className="font-semibold">业务时区</p>
                  <p className="mt-1 break-words leading-5 text-[var(--color-muted)]">
                    Australia/Melbourne
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Database
                  aria-hidden="true"
                  className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-info)]"
                />
                <div>
                  <p className="font-semibold">存储时区</p>
                  <p className="mt-1 leading-5 text-[var(--color-muted)]">UTC</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </AppShell>
  );
}
