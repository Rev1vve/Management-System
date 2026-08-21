import {
  BarChart3,
  BriefcaseBusiness,
  ClipboardCheck,
  ContactRound,
  FolderKanban,
  House,
  Layers3,
  NotebookPen,
  Settings,
  ShoppingCart,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type SystemRoleKey =
  'ADMIN' | 'EMPLOYEE' | 'APPROVER' | 'PROJECT_MANAGER' | 'PORTFOLIO_DIRECTOR' | 'EXECUTIVE';

export interface NavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group: 'workspace' | 'management' | 'administration';
}

const ITEMS: Record<string, NavigationItem> = {
  home: { href: '/', label: '工作台', icon: House, group: 'workspace' },
  customers: { href: '/customers', label: '客户', icon: ContactRound, group: 'workspace' },
  portfolios: { href: '/portfolios', label: '项目集', icon: Layers3, group: 'workspace' },
  projects: { href: '/projects', label: '项目', icon: FolderKanban, group: 'workspace' },
  orders: { href: '/orders', label: '订单', icon: ShoppingCart, group: 'workspace' },
  worklogs: { href: '/worklogs', label: '工作日志', icon: NotebookPen, group: 'workspace' },
  approvals: { href: '/approvals', label: '审批', icon: ClipboardCheck, group: 'management' },
  reports: { href: '/reports', label: '报表', icon: BarChart3, group: 'management' },
  users: { href: '/admin/users', label: '用户管理', icon: UsersRound, group: 'administration' },
  settings: { href: '/admin/settings', label: '系统设置', icon: Settings, group: 'administration' },
  profile: { href: '/profile', label: '个人资料', icon: BriefcaseBusiness, group: 'management' },
};

const ROLE_ITEM_KEYS: Record<SystemRoleKey, readonly string[]> = {
  ADMIN: ['home', 'users', 'settings', 'profile'],
  EMPLOYEE: ['home', 'customers', 'portfolios', 'projects', 'orders', 'worklogs', 'profile'],
  APPROVER: ['home', 'approvals', 'profile'],
  PROJECT_MANAGER: ['home', 'customers', 'portfolios', 'projects', 'orders', 'worklogs', 'profile'],
  PORTFOLIO_DIRECTOR: ['home', 'portfolios', 'projects', 'reports', 'profile'],
  EXECUTIVE: ['home', 'portfolios', 'projects', 'reports', 'profile'],
};

/**
 * UX-only navigation filtering. API authorization remains authoritative.
 * Multiple roles are merged in stable product order and de-duplicated.
 */
export function getNavigationItems(roles: readonly SystemRoleKey[]): NavigationItem[] {
  const permittedKeys = new Set(roles.flatMap((role) => ROLE_ITEM_KEYS[role]));
  const productOrder = [
    'home',
    'customers',
    'portfolios',
    'projects',
    'orders',
    'worklogs',
    'approvals',
    'reports',
    'users',
    'settings',
    'profile',
  ];

  return productOrder.flatMap((key) => {
    const item = ITEMS[key];
    return permittedKeys.has(key) && item ? [item] : [];
  });
}

export const navigationGroupLabels: Record<NavigationItem['group'], string> = {
  workspace: '工作区',
  management: '管理',
  administration: '系统管理',
};
