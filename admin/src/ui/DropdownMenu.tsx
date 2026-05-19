import * as DM from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from './cn';

export const DropdownMenu        = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;

export function DropdownMenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-[180px] bg-bg-1 border border-line rounded-2 shadow-d-2 p-1"
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function DropdownMenuItem({
  children, onSelect, danger,
}: { children: ReactNode; onSelect?: () => void; danger?: boolean }) {
  return (
    <DM.Item
      onSelect={onSelect}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-1 text-[13px] cursor-pointer outline-none',
        danger ? 'text-danger hover:bg-danger/10' : 'text-fg-0 hover:bg-bg-2'
      )}
    >
      {children}
    </DM.Item>
  );
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}
