import { cn } from './cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('relative overflow-hidden bg-bg-2 rounded-2', className)}
      style={{
        backgroundImage: 'linear-gradient(90deg, transparent, rgba(255,255,255,.04), transparent)',
        backgroundSize: '200% 100%',
        animation: 'sk-shimmer 1.2s infinite',
      }}
    >
      <style>{`@keyframes sk-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
    </div>
  );
}

export const SkeletonText = ({ lines = 3 }: { lines?: number }) => (
  <div className="space-y-2">
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
    ))}
  </div>
);

export const SkeletonRow = () => (
  <div className="flex items-center gap-3 p-3">
    <Skeleton className="h-9 w-9 rounded-full" />
    <div className="flex-1 space-y-2">
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  </div>
);
