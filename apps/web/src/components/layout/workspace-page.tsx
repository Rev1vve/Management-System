import { CircleHelp, Plus, Search } from 'lucide-react';

import { AppShell } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { Table, TableContainer, TableHead } from '@/components/ui/table';

interface WorkspacePageProps {
  title: string;
  description: string;
  columns: readonly string[];
  actionLabel: string;
}

export function WorkspacePage({ title, description, columns, actionLabel }: WorkspacePageProps) {
  return (
    <AppShell>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Badge variant="neutral">准备中</Badge>
          <h1 className="mt-3 text-2xl font-bold tracking-[-0.01em] text-[var(--color-navy)] sm:text-[28px]">
            {title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--color-muted)]">
            {description}
          </p>
        </div>
        <Button type="button" disabled aria-label={`${actionLabel}（尚未开放）`}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          {actionLabel}
        </Button>
      </header>

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-col gap-3 border-b border-[var(--color-border)] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-sm">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
              />
              <Input
                type="search"
                aria-label={`搜索${title}`}
                placeholder={`搜索${title}`}
                className="pl-9"
                disabled
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <CircleHelp aria-hidden="true" className="h-4 w-4 shrink-0" />
              数据服务启用后开放搜索、筛选与排序
            </div>
          </div>

          <TableContainer>
            <Table aria-label={`${title}列表`}>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <TableHead key={column}>{column}</TableHead>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={columns.length} className="p-4">
                    <EmptyState
                      title="功能准备中"
                      description="数据服务启用后，这里会显示你有权限访问的信息。"
                      className="border-0 bg-white py-8"
                    />
                  </td>
                </tr>
              </tbody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </AppShell>
  );
}
