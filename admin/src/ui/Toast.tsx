import { Toaster, toast as sonnerToast } from 'sonner';

export function ToastRoot() {
  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      toastOptions={{
        className: '!bg-bg-2 !text-fg-0 !border !border-line !rounded-2',
      }}
    />
  );
}

export const toast = sonnerToast;
