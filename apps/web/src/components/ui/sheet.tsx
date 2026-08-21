'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import { cn } from '@/lib/utils';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  className,
  returnFocusRef,
}: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--color-navy-strong)]/45 data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <Dialog.Content
          className={cn(
            'fixed inset-y-0 left-0 z-50 w-[min(88vw,320px)] overflow-y-auto bg-[var(--color-navy)] text-white shadow-[var(--shadow-overlay)] outline-none',
            className,
          )}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusRef?.current) return;
            event.preventDefault();
            returnFocusRef.current.focus();
          }}
        >
          <div className="flex min-h-16 items-center justify-between border-b border-white/15 px-4">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label="关闭导航菜单"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
