import type { ReactNode } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { Card } from '../ui/Card';

interface Props {
  label: string;
  value: string | number;
  delta?: { value: number; positive: boolean };
  sub?: string;
  icon?: ReactNode;
  spark?: ReactNode;
}

export default function KPICard({ label, value, delta, sub, icon, spark }: Props) {
  return (
    <Card padding="md" className="relative">
      <div className="flex items-start justify-between">
        <div className="text-[11px] uppercase tracking-wider text-fg-2">{label}</div>
        {icon && <div className="text-fg-2">{icon}</div>}
      </div>
      <div className="flex items-baseline gap-2 mt-2">
        <div className="num text-[28px] font-semibold text-fg-0 leading-none">{value}</div>
        {delta && (
          <div className={`num text-[12px] flex items-center gap-0.5 ${delta.positive ? 'text-ok' : 'text-danger'}`}>
            {delta.positive ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {Math.abs(delta.value)}%
          </div>
        )}
      </div>
      {sub && <div className="text-[12px] text-fg-2 mt-1">{sub}</div>}
      {spark && <div className="mt-3 -mx-1">{spark}</div>}
    </Card>
  );
}
