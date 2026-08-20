/**
 * Permission kernel for the Project Operations Center (plan task 6).
 *
 * Single source of truth for the role -> permission matrix. The seed script
 * and the test fixtures both derive from ROLE_DEFINITIONS, so the runtime
 * database rows (permissions / role_permissions) cannot drift from the
 * matrix the guards enforce.
 *
 * Design decisions (plan task 6):
 *  - The ADMIN role grants management permissions only (invite, user
 *    management, audit, settings). It carries NO business data permissions:
 *    business access flows through project scope, never through admin status.
 *  - EMPLOYEE holds no system-level permissions; employees access business
 *    data exclusively through project memberships.
 *  - Keys follow `resource:action[:scope]` so future business modules
 *    (tasks 7-10) can extend the matrix without redesign.
 */
export const PERMISSIONS = {
  USER_INVITE: 'user:invite',
  USER_MANAGE: 'user:manage',
  AUDIT_VIEW: 'audit:view',
  SYSTEM_SETTINGS: 'system:settings',
  PROJECT_VIEW: 'project:view',
  PROJECT_MANAGE: 'project:manage',
  WORKLOG_MANAGE: 'worklog:manage',
  PORTFOLIO_VIEW: 'portfolio:view',
  REPORT_VIEW: 'report:view',
  APPROVAL_DECIDE: 'approval:decide',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  [PERMISSIONS.USER_INVITE]: '邀请新用户',
  [PERMISSIONS.USER_MANAGE]: '管理用户（停用、角色分配）',
  [PERMISSIONS.AUDIT_VIEW]: '查看审计日志',
  [PERMISSIONS.SYSTEM_SETTINGS]: '管理系统设置',
  [PERMISSIONS.PROJECT_VIEW]: '查看项目（跨项目/组合级）',
  [PERMISSIONS.PROJECT_MANAGE]: '管理已分配项目',
  [PERMISSIONS.WORKLOG_MANAGE]: '管理工作日志（项目内）',
  [PERMISSIONS.PORTFOLIO_VIEW]: '查看项目集',
  [PERMISSIONS.REPORT_VIEW]: '查看报表',
  [PERMISSIONS.APPROVAL_DECIDE]: '审批决策',
};

export const SYSTEM_ROLE_KEYS = [
  'ADMIN',
  'EMPLOYEE',
  'APPROVER',
  'PROJECT_MANAGER',
  'PORTFOLIO_DIRECTOR',
  'EXECUTIVE',
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface RoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** Privileged roles must have TOTP enabled (plan D-056). */
  requiresMfa: boolean;
  permissions: readonly PermissionKey[];
}

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: 'ADMIN',
    name: '系统管理员',
    description: '管理用户、邀请与系统配置；不持有业务数据权限',
    requiresMfa: true,
    permissions: [
      PERMISSIONS.USER_INVITE,
      PERMISSIONS.USER_MANAGE,
      PERMISSIONS.AUDIT_VIEW,
      PERMISSIONS.SYSTEM_SETTINGS,
    ],
  },
  {
    key: 'EMPLOYEE',
    name: '普通员工',
    description: '基础员工；业务访问通过项目成员关系',
    requiresMfa: false,
    permissions: [],
  },
  {
    key: 'APPROVER',
    name: '审批人',
    description: '对提交的工作日志与单据做出审批决策',
    requiresMfa: true,
    permissions: [PERMISSIONS.APPROVAL_DECIDE],
  },
  {
    key: 'PROJECT_MANAGER',
    name: '项目经理',
    description: '管理其负责的项目与项目内工作日志',
    requiresMfa: true,
    permissions: [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_MANAGE, PERMISSIONS.WORKLOG_MANAGE],
  },
  {
    key: 'PORTFOLIO_DIRECTOR',
    name: '项目总监',
    description: '跨项目查看与组合级报表',
    requiresMfa: true,
    permissions: [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PORTFOLIO_VIEW, PERMISSIONS.REPORT_VIEW],
  },
  {
    key: 'EXECUTIVE',
    name: '高层领导',
    description: '高层级跨项目查看与报表',
    requiresMfa: true,
    permissions: [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PORTFOLIO_VIEW, PERMISSIONS.REPORT_VIEW],
  },
];

/** All permission keys referenced by the matrix, de-duplicated. */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = [
  ...new Set(ROLE_DEFINITIONS.flatMap((r) => r.permissions)),
];
