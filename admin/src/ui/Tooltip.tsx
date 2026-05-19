import * as Tip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Tip.Provider delayDuration={300}>{children}</Tip.Provider>;
}

export function Tooltip({ label, children, side = 'right' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Tip.Root>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content
          side={side}
          sideOffset={6}
          className="z-50 px-2 py-1 text-[11px] rounded-1 bg-bg-2 text-fg-0 border border-line shadow-d-2"
        >
          {label}
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  );
}
