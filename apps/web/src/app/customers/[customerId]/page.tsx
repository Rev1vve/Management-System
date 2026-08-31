'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TableCell, TableContainer, TableHead } from '@/components/ui/table';
import { api, ApiError, CustomerContact, CustomerDetail } from '@/lib/api';
import { errorCopy } from '@/components/business/resource-list-page';

const schema = z.object({
  number: z.string().trim().min(1, '请输入客户编号').max(100),
  name: z.string().trim().min(1, '请输入客户名称').max(200),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
type FormValues = z.infer<typeof schema>;
const statusLabels = { ACTIVE: '活跃', INACTIVE: '停用', ARCHIVED: '已归档' } as const;
const editableStatus = (status: CustomerDetail['status']): FormValues['status'] =>
  status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
const fieldClass = 'space-y-1 text-sm font-medium text-[var(--color-text)]';
const selectClass =
  'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3';

function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  const copy = errorCopy(error, '客户', '维护');
  return (
    <p role="alert" className="text-sm text-[var(--color-danger)]">
      {copy.title}：{error instanceof ApiError ? error.message : copy.description}
    </p>
  );
}

function CustomerForm({ customer, onCancel }: { customer: CustomerDetail; onCancel: () => void }) {
  const client = useQueryClient();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      number: customer.number,
      name: customer.name,
      status: editableStatus(customer.status),
    },
  });
  useEffect(
    () =>
      form.reset({
        number: customer.number,
        name: customer.name,
        status: editableStatus(customer.status),
      }),
    [customer, form],
  );
  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.updateCustomer(customer.id, { ...values, version: customer.version }),
    onSuccess: (value) => {
      client.setQueryData(['customer', customer.id], value);
      onCancel();
    },
  });
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
      className="space-y-4"
      aria-label="编辑客户表单"
    >
      <label className={fieldClass}>
        客户编号
        <Input {...form.register('number')} />
        {form.formState.errors.number ? (
          <span role="alert">{form.formState.errors.number.message}</span>
        ) : null}
      </label>
      <label className={fieldClass}>
        客户名称
        <Input {...form.register('name')} />
        {form.formState.errors.name ? (
          <span role="alert">{form.formState.errors.name.message}</span>
        ) : null}
      </label>
      <label className={fieldClass}>
        客户状态
        <select className={selectClass} {...form.register('status')}>
          <option value="ACTIVE">活跃</option>
          <option value="INACTIVE">停用</option>
        </select>
      </label>
      <MutationError error={mutation.error} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? '保存中…' : '保存客户'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function Contacts({ customer }: { customer: CustomerDetail }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<CustomerContact | 'new' | null>(null);
  const [name, setName] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const result = useQuery({
    queryKey: ['customer-contacts', customer.id],
    queryFn: () => api.listCustomerContacts(customer.id),
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['customer-contacts', customer.id] }),
      client.invalidateQueries({ queryKey: ['customer', customer.id] }),
    ]);
    setEditing(null);
  };
  const create = useMutation({
    mutationFn: () =>
      api.createCustomerContact(customer.id, {
        version: customer.version,
        name,
        workEmail: workEmail || null,
        phone: phone || null,
        position: position || null,
        isPrimary,
      }),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (contact: CustomerContact) =>
      api.updateCustomerContact(customer.id, contact.id, {
        version: customer.version,
        name,
        workEmail: workEmail || null,
        phone: phone || null,
        position: position || null,
        isPrimary,
      }),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: (contactId: string) =>
      api.archiveCustomerContact(customer.id, contactId, { version: customer.version }),
    onSuccess: refresh,
  });
  function begin(contact?: CustomerContact) {
    setEditing(contact ?? 'new');
    setName(contact?.name ?? '');
    setWorkEmail(contact?.workEmail ?? '');
    setPhone(contact?.phone ?? '');
    setPosition(contact?.position ?? '');
    setIsPrimary(contact?.isPrimary ?? false);
  }
  if (result.isLoading) return <LoadingState title="正在加载联系人" />;
  if (result.isError) return <ErrorState {...errorCopy(result.error, '客户联系人')} />;
  const mutationError = create.error ?? update.error ?? archive.error;
  return (
    <section aria-labelledby="contacts-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="contacts-title" className="text-lg font-semibold">
          客户联系人
        </h2>
        {customer.canManage === true ? (
          <Button type="button" onClick={() => begin()}>
            新增联系人
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          aria-label={editing === 'new' ? '新增联系人表单' : '编辑联系人表单'}
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            if (editing === 'new') create.mutate();
            else update.mutate(editing);
          }}
        >
          <label className={fieldClass}>
            联系人姓名
            <Input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className={fieldClass}>
            工作邮箱
            <Input
              type="email"
              value={workEmail}
              onChange={(event) => setWorkEmail(event.target.value)}
            />
          </label>
          <label className={fieldClass}>
            联系电话
            <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
          </label>
          <label className={fieldClass}>
            职位
            <Input value={position} onChange={(event) => setPosition(event.target.value)} />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(event) => setIsPrimary(event.target.checked)}
            />
            主要联系人
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" disabled={create.isPending || update.isPending}>
              保存联系人
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              取消
            </Button>
          </div>
          <div className="sm:col-span-2">
            <MutationError error={mutationError} />
          </div>
        </form>
      ) : null}
      {result.data?.length === 0 ? (
        <EmptyState title="暂无联系人" description="客户联系人会显示在这里。" />
      ) : null}
      {result.data && result.data.length > 0 ? (
        <TableContainer>
          <Table aria-label="客户联系人列表">
            <thead>
              <tr>
                <TableHead>姓名</TableHead>
                <TableHead>职位</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>电话</TableHead>
                <TableHead>操作</TableHead>
              </tr>
            </thead>
            <tbody>
              {result.data.map((contact) => (
                <tr key={contact.id}>
                  <TableCell>
                    {contact.name}
                    {contact.isPrimary ? '（主要）' : ''}
                  </TableCell>
                  <TableCell>{contact.position || '—'}</TableCell>
                  <TableCell>{contact.workEmail || '—'}</TableCell>
                  <TableCell>{contact.phone || '—'}</TableCell>
                  <TableCell>
                    {customer.canManage === true ? (
                      <div className="flex gap-2">
                        <Button type="button" variant="secondary" onClick={() => begin(contact)}>
                          编辑联系人
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          disabled={archive.isPending}
                          onClick={() => archive.mutate(contact.id)}
                        >
                          归档联系人
                        </Button>
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      ) : null}
    </section>
  );
}

function Attachments({ customerId }: { customerId: string }) {
  const client = useQueryClient();
  const result = useQuery({
    queryKey: ['customer-attachments', customerId],
    queryFn: () => api.listCustomerContractAttachments(customerId),
  });
  const [error, setError] = useState<unknown>();
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadCustomerContractAttachment(customerId, file),
    onSuccess: () => client.invalidateQueries({ queryKey: ['customer-attachments', customerId] }),
  });
  const archive = useMutation({
    mutationFn: (attachmentId: string) =>
      api.archiveCustomerContractAttachment(customerId, attachmentId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['customer-attachments', customerId] }),
  });
  async function download(attachmentId: string, fallbackName: string) {
    setError(undefined);
    try {
      const value = await api.downloadCustomerContractAttachment(customerId, attachmentId);
      const url = URL.createObjectURL(value.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fallbackName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught);
    }
  }
  if (result.isLoading) return <LoadingState title="正在加载合同附件" />;
  if (result.isError) return <ErrorState {...errorCopy(result.error, '合同附件')} />;
  const canManage = result.data?.canManage === true;
  return (
    <section aria-labelledby="attachments-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="attachments-title" className="text-lg font-semibold">
          合同附件
        </h2>
        {canManage ? (
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-[var(--radius-control)] bg-[var(--color-navy)] px-4 text-sm font-semibold text-white">
            上传合同附件
            <input
              className="sr-only"
              aria-label="上传合同附件"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
        ) : null}
      </div>
      <MutationError error={upload.error ?? archive.error ?? error} />
      {result.data?.items.length === 0 ? (
        <EmptyState title="暂无合同附件" description="服务端返回的合同附件会显示在这里。" />
      ) : null}
      {result.data && result.data.items.length > 0 ? (
        <TableContainer>
          <Table aria-label="合同附件列表">
            <thead>
              <tr>
                <TableHead>文件名</TableHead>
                <TableHead>大小</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>操作</TableHead>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((item) => (
                <tr key={item.id}>
                  <TableCell>{item.originalName}</TableCell>
                  <TableCell>{item.sizeBytes} B</TableCell>
                  <TableCell>{item.status === 'ACTIVE' ? '有效' : '已归档'}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => download(item.id, item.originalName)}
                      >
                        下载
                      </Button>
                      {canManage && item.status === 'ACTIVE' ? (
                        <Button
                          type="button"
                          variant="danger"
                          disabled={archive.isPending}
                          onClick={() => archive.mutate(item.id)}
                        >
                          归档附件
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      ) : null}
    </section>
  );
}

export default function CustomerDetailPage() {
  const params = useParams<{ customerId: string }>();
  const router = useRouter();
  const customerId = params.customerId;
  const [editing, setEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const result = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api.getCustomer(customerId),
    enabled: Boolean(customerId),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveCustomer(customerId, { version: result.data!.version }),
    onSuccess: () => router.push('/customers'),
  });
  return (
    <AppShell>
      <div className="mb-5">
        <Link className="inline-flex min-h-11 items-center text-sm underline" href="/customers">
          返回客户列表
        </Link>
      </div>
      {result.isLoading ? <LoadingState title="正在加载客户" /> : null}
      {result.isError ? <ErrorState {...errorCopy(result.error, '客户')} /> : null}
      {result.data ? (
        <div className="space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm text-[var(--color-muted)]">客户详情</p>
              <h1 className="mt-1 text-2xl font-bold">{result.data.name}</h1>
            </div>
            {result.data.canManage === true && result.data.status !== 'ARCHIVED' ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
                  编辑客户
                </Button>
                <Button type="button" variant="danger" onClick={() => setConfirmingArchive(true)}>
                  归档客户
                </Button>
              </div>
            ) : null}
          </header>
          {confirmingArchive ? (
            <Card>
              <CardContent className="space-y-3">
                <p>确认归档此客户？归档后将返回客户列表。</p>
                <MutationError error={archive.error} />
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    disabled={archive.isPending}
                    onClick={() => archive.mutate()}
                  >
                    确认归档
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmingArchive(false)}>
                    取消
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <h2 className="font-semibold">基本信息</h2>
            </CardHeader>
            <CardContent>
              {editing ? (
                <CustomerForm customer={result.data} onCancel={() => setEditing(false)} />
              ) : (
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-[var(--color-muted)]">客户编号</dt>
                    <dd>{result.data.number}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-[var(--color-muted)]">状态</dt>
                    <dd>{statusLabels[result.data.status]}</dd>
                  </div>
                  {result.data.notes !== undefined ? (
                    <div className="sm:col-span-2">
                      <dt className="text-sm text-[var(--color-muted)]">备注</dt>
                      <dd>{result.data.notes || '—'}</dd>
                    </div>
                  ) : null}
                </dl>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Contacts customer={result.data} />
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Attachments customerId={customerId} />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
