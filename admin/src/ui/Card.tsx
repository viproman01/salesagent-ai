import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md';
}

export function Card({ padding = 'md', className, children, ...rest }: CardProps) {
  const pad = padding === 'none' ? '' : padding === 'sm' ? 'p-3' : 'p-5';
  return (
    <div
      className={cn('bg-bg-1 border border-line rounded-3 shadow-d-1', pad, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[14px] font-semibold text-fg-0">{title}</h3>
      {action}
    </div>
  );
}
