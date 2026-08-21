'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Menu, Search } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  getNavigationItems,
  navigationGroupLabels,
  type NavigationItem,
  type SystemRoleKey,
} from './navigation';

interface AppShellProps {
  children: ReactNode;
  roles?: readonly SystemRoleKey[];
  user?: { name: string; account: string };
}

function ProductMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-white text-sm font-extrabold text-[var(--color-navy)]"
        aria-hidden="true"
      >
        项
      </span>
      {!compact ? (
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold tracking-wide text-white">
            项目运营中心
          </span>
          <span className="block text-xs text-white/60">内部工作台</span>
        </span>
      ) : null}
    </div>
  );
}

function isCurrentRoute(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationLinks({
  items,
  pathname,
  onNavigate,
}: {
  items: NavigationItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const groups = ['workspace', 'management', 'administration'] as const;

  return (
    <nav aria-label="主导航" className="space-y-5 px-3 py-4">
      {groups.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) return null;
        return (
          <section key={group} aria-label={navigationGroupLabels[group]}>
            <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">
              {navigationGroupLabels[group]}
            </p>
            <ul className="space-y-1">
              {groupItems.map((item) => {
                const active = isCurrentRoute(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      {...(onNavigate ? { onClick: onNavigate } : {})}
                      className={cn(
                        'flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium text-white/72 transition-colors hover:bg-white/8 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white',
                        active && 'bg-white text-[var(--color-navy)] shadow-sm hover:bg-white',
                      )}
                    >
                      <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

export function AppShell({ children, roles = ['EMPLOYEE'], user }: AppShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const items = getNavigationItems(roles);
  const currentItem = items.find((item) => isCurrentRoute(pathname, item.href));

  return (
    <div className="min-h-dvh bg-[var(--color-page)] text-[var(--color-text)]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-24 rounded-[var(--radius-control)] bg-white px-4 py-3 font-semibold text-[var(--color-navy)] shadow-lg focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      >
        跳到主要内容
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-[var(--color-navy)] lg:flex">
        <div className="flex min-h-16 items-center border-b border-white/15 px-5">
          <ProductMark />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavigationLinks items={items} pathname={pathname} />
        </div>
        <div className="border-t border-white/15 p-4">
          <Link
            href="/profile"
            className="flex min-h-12 items-center gap-3 rounded-[var(--radius-control)] px-2 hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/12 text-sm font-bold text-white">
              {user?.name.slice(0, 1) ?? '我'}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-white">
                {user?.name ?? '个人资料'}
              </span>
              <span className="block truncate text-xs text-white/55">
                {user ? `@${user.account}` : '查看账号与会话'}
              </span>
            </span>
          </Link>
        </div>
      </aside>

      <Sheet
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        title="导航菜单"
        returnFocusRef={mobileMenuButtonRef}
      >
        <div className="px-4 py-4">
          <ProductMark />
        </div>
        <NavigationLinks
          items={items}
          pathname={pathname}
          onNavigate={() => setMobileOpen(false)}
        />
      </Sheet>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-[var(--color-border)] bg-white/95 px-4 backdrop-blur-sm sm:px-6">
          <Button
            ref={mobileMenuButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="打开导航菜单"
            onClick={() => setMobileOpen(true)}
            className="lg:hidden"
          >
            <Menu aria-hidden="true" className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--color-navy)]">
              {currentItem?.label ?? '项目运营中心'}
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="搜索" disabled>
            <Search aria-hidden="true" className="h-5 w-5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="通知" disabled>
            <Bell aria-hidden="true" className="h-5 w-5" />
          </Button>
          <Link
            href="/profile"
            className="grid h-11 w-11 place-items-center rounded-full bg-[var(--color-navy)] text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 lg:hidden"
            aria-label="个人资料"
          >
            {user?.name.slice(0, 1) ?? '我'}
          </Link>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1600px] p-4 sm:p-6 lg:p-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
