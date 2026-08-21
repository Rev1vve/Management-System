import type { HTMLAttributes, TableHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export function TableContainer({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('w-full overflow-x-auto', className)} {...props} />;
}

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn('w-full min-w-[640px] border-collapse text-sm', className)} {...props} />
  );
}

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'h-10 border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn('h-11 border-b border-[var(--color-border)] px-3 align-middle', className)}
      {...props}
    />
  );
}
