import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--focus-ring)]/20 disabled:cursor-not-allowed disabled:bg-[var(--color-surface-subtle)] disabled:opacity-70',
        className,
      )}
      {...props}
    />
  );
}
