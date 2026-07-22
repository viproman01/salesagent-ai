import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size    = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

const base = 'inline-flex items-center gap-2 font-medium rounded-2 select-none transition-colors ease-sharp duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-9 px-3.5 text-[13px]',
};

const variants: Record<Variant, string> = {
  primary:   'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'bg-bg-2 text-fg-0 hover:bg-line border border-line',
  ghost:     'bg-transparent text-fg-1 hover:text-fg-0 hover:bg-bg-2',
  danger:    'bg-danger text-white hover:brightness-110',
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'primary', size = 'md', iconLeft, iconRight, loading, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(base, sizes[size], variants[variant], className)}
      {...rest}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  )
);
Button.displayName = 'Button';
