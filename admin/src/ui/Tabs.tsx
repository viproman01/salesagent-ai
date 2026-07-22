import * as T from '@radix-ui/react-tabs';
import { cn } from './cn';
import type { ReactNode } from 'react';

export const Tabs = T.Root;

export function TabsList({ children }: { children: ReactNode }) {
  return (
    <T.List className="flex gap-1 border-b border-line">
      {children}
    </T.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className={cn(
        'px-3 h-9 text-[13px] text-fg-1 border-b-2 border-transparent',
        'data-[state=active]:text-fg-0 data-[state=active]:border-accent transition-colors'
      )}
    >
      {children}
    </T.Trigger>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  return <T.Content value={value} className="pt-4 outline-none">{children}</T.Content>;
}
