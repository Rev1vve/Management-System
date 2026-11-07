/** Same-origin typed API client. Server authorization is always authoritative. */
const CSRF_HEADER = 'x-requested-with';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set(CSRF_HEADER, 'XMLHttpRequest');
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (typeof body.message === 'string') message = body.message;
      else if (Array.isArray(body.message)) message = body.message.join('；');
    } catch {
      /* retain honest generic message */
    }
    throw new ApiError(message, response.status);
  }
  return response;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  canManage?: boolean;
}
export interface ListQuery {
  page: number;
  pageSize?: number;
  search?: string;
  status?: string;
}
export type CustomerStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type PortfolioStatus = 'ACTIVE' | 'ARCHIVED';
export type ProjectStatus = 'DRAFT' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
export type OrderStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'ARCHIVED';
export type OrderItemStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface CustomerSummary {
  id: string;
  number: string;
  name: string;
  status: CustomerStatus;
  version: number;
  updatedAt: string;
}
export interface CustomerDetail extends CustomerSummary {
  notes?: string | null;
  contacts?: CustomerContact[];
  canManage?: boolean;
}
export interface CustomerContact {
  id: string;
  customerId: string;
  name: string;
  workEmail?: string | null;
  phone?: string | null;
  position?: string | null;
  isPrimary: boolean;
  createdAt?: string;
  updatedAt?: string;
}
export interface PortfolioSummary {
  id: string;
  name: string;
  description?: string | null;
  status: PortfolioStatus;
  updatedAt: string;
  canManage?: boolean;
}

export interface ApprovalListItem {
  id: string;
  submittedAt: string;
  canDecide: boolean;
  workLogVersion: {
    id: string;
    versionNumber: number;
    workDate: string;
    hours: string | number;
    completion: string;
    workLog: {
      id: string;
      number: string;
      currentVersionId: string | null;
      project: { id: string; number: string; name: string } | null;
      author: { id: string; name: string };
    };
  };
}

export type ApprovalDecision = 'APPROVED' | 'RETURNED' | 'REJECTED';

export interface NotificationItem {
  id: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  title: string;
  body: string | null;
  status: 'UNREAD' | 'READ';
  readAt: string | null;
  createdAt: string;
}

export type WorkLogStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETURNED' | 'REJECTED';
export type WorkLogVisibility = 'PRIVATE' | 'PROJECT_VISIBLE';

export interface WorkLogVersionSummary {
  id: string;
  versionNumber: number;
  workDate: string;
  hours: string | number;
  completion: string;
  progressNote?: string | null;
  submittedAt: string;
}

export interface WorkLogListItem {
  id: string;
  number: string;
  status: WorkLogStatus;
  visibility: WorkLogVisibility;
  version: number;
  project: { id: string; number: string; name: string } | null;
  currentVersion: {
    versionNumber: number;
    workDate: string;
    hours: string | number;
    submittedAt: string;
  } | null;
}

export interface WorkLogDetail {
  id: string;
  number: string;
  status: WorkLogStatus;
  visibility: WorkLogVisibility;
  version: number;
  projectId: string;
  currentVersion: WorkLogVersionSummary | null;
  versions: Array<{ id: string; versionNumber: number; submittedAt: string }>;
}

export interface WorkLogCreate {
  projectId: string;
  workDate: string;
  hours: number;
  completion: string;
  progressNote?: string | null;
  visibility?: WorkLogVisibility;
}

export interface WorkLogAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  number: string;
  name: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status: ProjectStatus;
  completionPercent: number;
  version: number;
  updatedAt: string;
  customer: { id: string; number: string; name: string } | null;
  portfolio: { id: string; name: string } | null;
  canManage?: boolean;
}
export interface OrderSummary {
  id: string;
  number: string;
  projectId: string;
  title: string;
  description?: string | null;
  startDate?: string | null;
  deliveryDate?: string | null;
  status: OrderStatus;
  version: number;
  updatedAt: string;
  project?: { id: string; number: string; name: string };
  canManage?: boolean;
}
export interface ProjectMember {
  id: string;
  userId: string;
  user: { id: string; name: string; workEmail: string };
  roles: Array<{ role: 'MEMBER' | 'PROJECT_MANAGER' | 'APPROVER' | 'OBSERVER' }>;
}
export interface OrderItem {
  id: string;
  orderId: string;
  name: string;
  quantity: number | string;
  unit?: string | null;
  plannedDate?: string | null;
  completedDate?: string | null;
  status: OrderItemStatus;
  sortOrder: number;
}
export interface ContractAttachment {
  id: string;
  originalName: string;
  mimeType:
    | 'application/pdf'
    | 'image/png'
    | 'image/jpeg'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  sizeBytes: number;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
}
export interface ContractAttachmentList {
  items: ContractAttachment[];
  canManage: boolean;
}

export type CustomerCreate = {
  projectId: string;
  number: string;
  name: string;
  notes?: string | null;
};
export type CustomerUpdate = {
  version: number;
  number?: string;
  name?: string;
  notes?: string | null;
  status?: Exclude<CustomerStatus, 'ARCHIVED'>;
};
export type CustomerContactWrite = {
  version: number;
  name?: string;
  workEmail?: string | null;
  phone?: string | null;
  position?: string | null;
  isPrimary?: boolean;
};
export type PortfolioWrite = {
  name: string;
  description?: string | null;
  status?: Exclude<PortfolioStatus, 'ARCHIVED'>;
  version?: number;
};
export type ProjectCreate = {
  number: string;
  name: string;
  customerId?: string | null;
  portfolioId?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};
export type ProjectUpdate = {
  version: number;
  number?: string;
  name?: string;
  customerId?: string | null;
  portfolioId?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: Exclude<ProjectStatus, 'ARCHIVED'>;
  completionPercent?: number;
};
export type OrderCreate = {
  number: string;
  title: string;
  description?: string | null;
  startDate?: string | null;
  deliveryDate?: string | null;
  status?: 'DRAFT';
};
export type OrderUpdate = {
  version: number;
  number?: string;
  title?: string;
  description?: string | null;
  startDate?: string | null;
  deliveryDate?: string | null;
  status?: Exclude<OrderStatus, 'ARCHIVED'>;
};
export type OrderItemWrite = {
  version: number;
  name?: string;
  quantity?: number;
  unit?: string | null;
  plannedDate?: string | null;
  completedDate?: string | null;
  status?: OrderItemStatus;
  sortOrder?: number;
};

function id(value: string) {
  return encodeURIComponent(value);
}
function listPath(resource: string, query: ListQuery): string {
  const parameters = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize ?? 20),
  });
  if (query.search) parameters.set('search', query.search);
  if (query.status) parameters.set('status', query.status);
  return `/${resource}?${parameters.toString()}`;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const api = {
  listCustomers: (q: ListQuery) =>
    request<PaginatedResponse<CustomerSummary>>(listPath('customers', q)),
  getCustomer: (customerId: string) => request<CustomerDetail>(`/customers/${id(customerId)}`),
  createCustomer: (body: CustomerCreate) =>
    request<CustomerDetail>('/customers', json('POST', body)),
  updateCustomer: (customerId: string, body: CustomerUpdate) =>
    request<CustomerDetail>(`/customers/${id(customerId)}`, json('PATCH', body)),
  archiveCustomer: (customerId: string, body: { version: number }) =>
    request<void>(`/customers/${id(customerId)}/archive`, json('POST', body)),
  listCustomerContacts: (customerId: string) =>
    request<CustomerContact[]>(`/customers/${id(customerId)}/contacts`),
  createCustomerContact: (customerId: string, body: CustomerContactWrite & { name: string }) =>
    request<CustomerContact>(`/customers/${id(customerId)}/contacts`, json('POST', body)),
  updateCustomerContact: (customerId: string, contactId: string, body: CustomerContactWrite) =>
    request<CustomerContact>(
      `/customers/${id(customerId)}/contacts/${id(contactId)}`,
      json('PATCH', body),
    ),
  archiveCustomerContact: (customerId: string, contactId: string, body: { version: number }) =>
    request<void>(
      `/customers/${id(customerId)}/contacts/${id(contactId)}/archive`,
      json('POST', body),
    ),

  listPortfolios: (q: ListQuery) =>
    request<PaginatedResponse<PortfolioSummary>>(listPath('portfolios', q)),
  getPortfolio: (portfolioId: string) =>
    request<PortfolioSummary>(`/portfolios/${id(portfolioId)}`),
  createPortfolio: (body: PortfolioWrite) =>
    request<PortfolioSummary>('/portfolios', json('POST', body)),
  updatePortfolio: (portfolioId: string, body: PortfolioWrite) =>
    request<PortfolioSummary>(`/portfolios/${id(portfolioId)}`, json('PATCH', body)),
  archivePortfolio: (portfolioId: string) =>
    request<void>(`/portfolios/${id(portfolioId)}/archive`, json('POST')),

  listProjects: (q: ListQuery) =>
    request<PaginatedResponse<ProjectSummary>>(listPath('projects', q)),
  getProject: (projectId: string) => request<ProjectSummary>(`/projects/${id(projectId)}`),
  createProject: (body: ProjectCreate) => request<ProjectSummary>('/projects', json('POST', body)),
  updateProject: (projectId: string, body: ProjectUpdate) =>
    request<ProjectSummary>(`/projects/${id(projectId)}`, json('PATCH', body)),
  archiveProject: (projectId: string, body: { version: number }) =>
    request<void>(`/projects/${id(projectId)}/archive`, json('POST', body)),
  listProjectMembers: (projectId: string) =>
    request<ProjectMember[]>(`/projects/${id(projectId)}/members`),
  addProjectMember: (
    projectId: string,
    body: { userId: string; roles: ProjectMember['roles'][number]['role'][] },
  ) => request<ProjectMember>(`/projects/${id(projectId)}/members`, json('POST', body)),
  updateProjectMember: (
    projectId: string,
    userId: string,
    body: { roles: ProjectMember['roles'][number]['role'][] },
  ) =>
    request<ProjectMember>(`/projects/${id(projectId)}/members/${id(userId)}`, json('PATCH', body)),
  removeProjectMember: (projectId: string, userId: string) =>
    request<void>(`/projects/${id(projectId)}/members/${id(userId)}`, json('DELETE')),

  listOrders: (projectId: string, q: ListQuery) =>
    request<PaginatedResponse<OrderSummary>>(listPath(`projects/${id(projectId)}/orders`, q)),
  getOrder: (projectId: string, orderId: string) =>
    request<OrderSummary>(`/projects/${id(projectId)}/orders/${id(orderId)}`),
  createOrder: (projectId: string, body: OrderCreate) =>
    request<OrderSummary>(`/projects/${id(projectId)}/orders`, json('POST', body)),
  updateOrder: (projectId: string, orderId: string, body: OrderUpdate) =>
    request<OrderSummary>(`/projects/${id(projectId)}/orders/${id(orderId)}`, json('PATCH', body)),
  archiveOrder: (projectId: string, orderId: string, body: { version: number }) =>
    request<void>(`/projects/${id(projectId)}/orders/${id(orderId)}/archive`, json('POST', body)),
  listOrderItems: (projectId: string, orderId: string) =>
    request<OrderItem[]>(`/projects/${id(projectId)}/orders/${id(orderId)}/items`),
  createOrderItem: (projectId: string, orderId: string, body: OrderItemWrite) =>
    request<OrderItem>(
      `/projects/${id(projectId)}/orders/${id(orderId)}/items`,
      json('POST', body),
    ),
  updateOrderItem: (projectId: string, orderId: string, itemId: string, body: OrderItemWrite) =>
    request<OrderItem>(
      `/projects/${id(projectId)}/orders/${id(orderId)}/items/${id(itemId)}`,
      json('PATCH', body),
    ),
  archiveOrderItem: (
    projectId: string,
    orderId: string,
    itemId: string,
    body: { version: number },
  ) =>
    request<void>(
      `/projects/${id(projectId)}/orders/${id(orderId)}/items/${id(itemId)}/archive`,
      json('POST', body),
    ),

  listCustomerContractAttachments: (customerId: string) =>
    request<ContractAttachmentList>(`/customers/${id(customerId)}/contract-attachments`),
  uploadCustomerContractAttachment: (customerId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ContractAttachment>(`/customers/${id(customerId)}/contract-attachments`, {
      method: 'POST',
      body: form,
    });
  },
  downloadCustomerContractAttachment: async (customerId: string, attachmentId: string) => {
    const response = await apiFetch(
      `/customers/${id(customerId)}/contract-attachments/${id(attachmentId)}/download`,
    );
    return {
      blob: await response.blob(),
      contentDisposition: response.headers.get('Content-Disposition'),
    };
  },
  archiveCustomerContractAttachment: (customerId: string, attachmentId: string) =>
    request<void>(
      `/customers/${id(customerId)}/contract-attachments/${id(attachmentId)}/archive`,
      json('POST'),
    ),

  login: (body: { accountOrEmail: string; password: string }) =>
    request<{ mfaRequired: boolean; mfaSetupRequired: boolean }>('/auth/login', json('POST', body)),
  me: () =>
    request<{
      id: string;
      account: string;
      name: string;
      workEmail: string;
      status: string;
      mfaEnabled: boolean;
    }>('/auth/me'),
  logout: () => request<{ ok: boolean }>('/auth/logout', json('POST')),
  logoutAll: () => request<{ ok: boolean }>('/auth/logout-all', json('POST')),
  acceptInvitation: (body: { token: string; name: string; password: string }) =>
    request<{ ok: boolean; account: string }>('/invitations/accept', json('POST', body)),
  createInvitation: (body: { email: string }) =>
    request<{ ok: boolean; invitationId: string; expiresAt: string }>(
      '/invitations',
      json('POST', body),
    ),
  mfaSetup: () => request<{ secret: string; otpauthUrl: string }>('/mfa/setup', json('POST')),
  mfaEnable: (body: { code: string }) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/mfa/enable', json('POST', body)),
  mfaDisable: (body: { password: string; code: string }) =>
    request<{ ok: boolean }>('/mfa/disable', json('POST', body)),
  mfaVerify: (body: { code: string }) =>
    request<{ ok: boolean; account: string }>('/mfa/verify', json('POST', body)),
  mfaRecoveryLogin: (body: { code: string }) =>
    request<{ ok: boolean; account: string }>('/mfa/recovery-login', json('POST', body)),
  mfaRecoveryRotate: (body: { password: string; code: string }) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/mfa/recovery-rotate', json('POST', body)),

  listApprovals: (q: { page: number; pageSize: number }) =>
    request<PaginatedResponse<ApprovalListItem>>(
      `/approvals?page=${encodeURIComponent(String(q.page))}&pageSize=${encodeURIComponent(String(q.pageSize))}`,
    ),
  decideApproval: (
    approvalId: string,
    body: { decision: ApprovalDecision; comment?: string | null },
  ) =>
    request<{ id: string; status: ApprovalDecision; workLogStatus: string }>(
      `/approvals/${id(approvalId)}/decisions`,
      json('POST', body),
    ),
  listNotifications: (q: { page: number; pageSize: number; unreadOnly?: boolean }) =>
    request<PaginatedResponse<NotificationItem> & { unread: number }>(
      `/notifications?page=${encodeURIComponent(String(q.page))}&pageSize=${encodeURIComponent(
        String(q.pageSize),
      )}${q.unreadOnly ? '&unread=true' : ''}`,
    ),
  markNotificationRead: (notificationId: string) =>
    request<{ ok: boolean }>(`/notifications/${id(notificationId)}/read`, json('POST', {})),
  listMyWorkLogs: (q: { page: number; pageSize: number }) =>
    request<PaginatedResponse<WorkLogListItem>>(
      `/my/work-logs?page=${encodeURIComponent(String(q.page))}&pageSize=${encodeURIComponent(String(q.pageSize))}`,
    ),
  getWorkLog: (workLogId: string) => request<WorkLogDetail>(`/work-logs/${id(workLogId)}`),
  createWorkLog: (body: WorkLogCreate) =>
    request<{ id: string; number: string; versionNumber: number; version: number }>(
      '/projects/' + encodeURIComponent(body.projectId) + '/work-logs',
      json('POST', body),
    ),
  updateWorkLogDraft: (
    workLogId: string,
    body: {
      version: number;
      workDate: string;
      hours: number;
      completion: string;
      progressNote?: string | null;
    },
  ) =>
    request<{ id: string; status: WorkLogStatus; version: number }>(
      `/work-logs/${id(workLogId)}`,
      json('PATCH', body),
    ),
  submitWorkLog: (workLogId: string, body: { approverId: string }) =>
    request<{ id: string; status: WorkLogStatus; approvalRequestId: string }>(
      `/work-logs/${id(workLogId)}/submit`,
      json('POST', body),
    ),
  addWorkLogVersion: (
    workLogId: string,
    body: { workDate: string; hours: number; completion: string; progressNote?: string | null },
  ) =>
    request<{ id: string; status: WorkLogStatus; versionNumber: number; version: number }>(
      `/work-logs/${id(workLogId)}/versions`,
      json('POST', body),
    ),
  setWorkLogVisibility: (
    workLogId: string,
    body: { visibility: WorkLogVisibility; version: number },
  ) =>
    request<{ id: string; visibility: WorkLogVisibility; version: number }>(
      `/work-logs/${id(workLogId)}/visibility`,
      json('PATCH', body),
    ),
  listWorkLogAttachments: (workLogId: string) =>
    request<WorkLogAttachment[]>(`/work-logs/${id(workLogId)}/attachments`),
  uploadWorkLogAttachment: (workLogId: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<WorkLogAttachment>(`/work-logs/${id(workLogId)}/attachments`, {
      method: 'POST',
      body,
    });
  },
  archiveWorkLogAttachment: (workLogId: string, attachmentId: string) =>
    request<{ ok: boolean }>(
      `/work-logs/${id(workLogId)}/attachments/${id(attachmentId)}/archive`,
      json('POST', {}),
    ),
  workLogAttachmentDownloadUrl: (workLogId: string, attachmentId: string) =>
    `/api/v1/work-logs/${id(workLogId)}/attachments/${id(attachmentId)}/download`,
  listSessions: () =>
    request<
      Array<{
        id: string;
        deviceInfo: string | null;
        createdAt: string;
        lastUsedAt: string | null;
        expiresAt: string;
      }>
    >('/sessions'),
  revokeSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/sessions/${id(sessionId)}`, json('DELETE')),
};
