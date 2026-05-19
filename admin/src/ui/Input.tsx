import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, hint, error, leftSlot, rightSlot, className, id, ...rest }, ref) => {
    const inputId = id || (label ? `in-${label.replace(/\s+/g, '-')}` : undefined);
    return (
      <label htmlFor={inputId} className="flex flex-col gap-1 text-[13px]">
        {label && <span className="text-fg-1">{label}</span>}
        <span className={cn(
          'flex items-center gap-2 h-9 px-3 rounded-2 bg-bg-1 border',
          error ? 'border-danger' : 'border-line',
          'focus-within:border-accent transition-colors'
        )}>
          {leftSlot}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'flex-1 bg-transparent outline-none placeholder:text-fg-2 text-fg-0',
              className
            )}
            {...rest}
          />
          {rightSlot}
        </span>
        {error
          ? <span className="text-[12px] text-danger">{error}</span>
          : hint && <span className="text-[12px] text-fg-2">{hint}</span>}
      </label>
    );
  }
);
Input.displayName = 'Input';
