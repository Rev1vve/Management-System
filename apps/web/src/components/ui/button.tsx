import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-navy)] text-white hover:bg-[var(--color-navy-strong)] active:bg-[var(--color-navy-strong)]',
        secondary:
          'border border-[var(--color-border)] bg-white text-[var(--color-navy)] hover:bg-[var(--color-surface-subtle)]',
        ghost: 'text-[var(--color-text)] hover:bg-black/5',
        danger: 'bg-[var(--color-danger)] text-white hover:bg-[#8f1c14]',
      },
      size: {
        default: 'h-11',
        sm: 'h-11 min-h-11 px-3',
        icon: 'h-11 w-11 px-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { buttonVariants };
