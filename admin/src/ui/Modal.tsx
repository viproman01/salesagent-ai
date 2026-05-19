import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Modal({
  open, onOpenChange, title, children, widthClass = 'max-w-md',
}: { open: boolean; onOpenChange: (v: boolean) => void; title?: ReactNode; children: ReactNode; widthClass?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[92vw] ${widthClass} bg-bg-1 border border-line rounded-4 shadow-d-3`}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-line">
            <Dialog.Title className="text-[14px] font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-fg-2 hover:text-fg-0">
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
