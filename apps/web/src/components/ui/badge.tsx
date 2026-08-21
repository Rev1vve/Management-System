import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const variants: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-50 text-[var(--color-success)]',
  warning: 'bg-amber-50 text-[var(--color-warning)]',
  danger: 'bg-red-50 text-[var(--color-danger)]',
  info: 'bg-blue-50 text-[var(--color-info)]',
};

export function Badge({
  className,
  variant = 'neutral',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center rounded-[var(--radius-pill)] px-2.5 py-0.5 text-xs font-semibold',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
