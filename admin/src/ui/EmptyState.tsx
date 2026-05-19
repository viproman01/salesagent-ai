import type { ReactNode } from 'react';
import { cn } from './cn';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-6', className)}>
      {icon && <div className="text-fg-2 mb-3">{icon}</div>}
      <h4 className="text-[15px] font-semibold text-fg-0">{title}</h4>
      {description && <p className="text-[13px] text-fg-1 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
