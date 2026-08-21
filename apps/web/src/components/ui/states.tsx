import { AlertTriangle, CheckCircle2, Inbox, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface StateProps {
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

function StateFrame({
  title,
  description,
  action,
  className,
  icon,
}: StateProps & { icon: ReactNode }) {
  return (
    <section
      className={cn(
        'flex min-h-56 flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] px-6 py-10 text-center',
        className,
      )}
    >
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-white text-[var(--color-muted)] shadow-sm">
        {icon}
      </div>
      <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--color-muted)]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </section>
  );
}

export function EmptyState(props: StateProps) {
  return <StateFrame {...props} icon={<Inbox aria-hidden="true" className="h-5 w-5" />} />;
}

export function LoadingState({ title = '正在加载' }: { title?: string }) {
  return (
    <div
      className="flex min-h-40 items-center justify-center gap-3 text-sm text-[var(--color-muted)]"
      role="status"
    >
      <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" />
      <span>{title}</span>
    </div>
  );
}

export function ErrorState(props: StateProps) {
  return (
    <StateFrame
      {...props}
      icon={<AlertTriangle aria-hidden="true" className="h-5 w-5 text-[var(--color-danger)]" />}
    />
  );
}

export function SuccessState(props: StateProps) {
  return (
    <StateFrame
      {...props}
      icon={<CheckCircle2 aria-hidden="true" className="h-5 w-5 text-[var(--color-success)]" />}
    />
  );
}
