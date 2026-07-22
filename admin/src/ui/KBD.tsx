import type { ReactNode } from 'react';
import { cn } from './cn';

export function KBD({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn(
      'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-1',
      'bg-bg-2 border border-line text-[10px] text-fg-1 font-mono',
      className
    )}>
      {children}
    </kbd>
  );
}
