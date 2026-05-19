import type { ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
type Size = 'sm' | 'md';

const tones: Record<Tone, string> = {
  neutral: 'bg-bg-2 text-fg-1 border-line',
  ok:      'bg-ok/10 text-ok border-ok/30',
  warn:    'bg-warn/10 text-warn border-warn/30',
  danger:  'bg-danger/10 text-danger border-danger/30',
  accent:  'bg-accent/15 text-accent border-accent/30',
};

const sizes: Record<Size, string> = {
  sm: 'h-5 px-1.5 text-[10px] font-medium',
  md: 'h-6 px-2 text-[11px] font-medium',
};

export function Badge({ tone = 'neutral', size = 'md', children }: { tone?: Tone; size?: Size; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-1 border tracking-wide uppercase', tones[tone], sizes[size])}>
      {children}
    </span>
  );
}
