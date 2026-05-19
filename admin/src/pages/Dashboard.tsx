import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Users, MessageCircle, TrendingUp, Zap } from 'lucide-react';
import api from '../api';
import type { FunnelItem, TrendItem } from '../api';
import KPICard from '../components/KPICard';
import Sparkline from '../components/Sparkline';
import FunnelChart from '../components/FunnelChart';
import { Card, CardHeader } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

interface DashboardData {
  metrics: {
    totalConversations: number;
    totalLeads:         number;
    conversionRate:     number;
    avgResponseTimeMs:  number;
  };
  funnel:       FunnelItem[];
  trend:        TrendItem[];
  subscription: { plan: string; messages_used: number; messages_limit: number } | null;
}

export default function Dashboard() {
  const orgId = localStorage.getItem('orgId') ?? '';
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard', orgId],
    queryFn:  () => api.get(`/dashboard/${orgId}`).then(r => r.data),
    refetchInterval: 60_000,
  });

  const m = data?.metrics;
  const sub = data?.subscription;
  const trend = data?.trend ?? [];
  const sparkData = trend.map(t => parseInt(t.conversations));

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {isLoading ? (
          <>
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[124px]" />
          </>
        ) : (
          <>
            <KPICard
              label="Лиды"
              value={(m?.totalLeads ?? 0).toLocaleString('ru')}
              icon={<Users size={14} />}
              spark={sparkData.length > 1 ? <Sparkline data={sparkData} /> : undefined}
            />
            <KPICard
              label="Разговоры"
              value={(m?.totalConversations ?? 0).toLocaleString('ru')}
              icon={<MessageCircle size={14} />}
              spark={sparkData.length > 1 ? <Sparkline data={sparkData} /> : undefined}
            />
            <KPICard
              label="Конверсия"
              value={`${m?.conversionRate ?? 0}%`}
              icon={<TrendingUp size={14} />}
            />
            <KPICard
              label="Ср. время ответа"
              value={m?.avgResponseTimeMs ? `${(m.avgResponseTimeMs / 1000).toFixed(1)}с` : '—'}
              icon={<Zap size={14} />}
            />
          </>
        )}
      </div>

      {sub && (
        <Card padding="sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] text-fg-1">
              План: <span className="text-accent font-medium capitalize">{sub.plan}</span>
            </span>
            <span className="num text-[11px] text-fg-2">
              {sub.messages_used.toLocaleString('ru')} / {sub.messages_limit.toLocaleString('ru')}
            </span>
          </div>
          <div className="w-full bg-bg-2 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-accent h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, (sub.messages_used / sub.messages_limit) * 100)}%` }}
            />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
        <div className="xl:col-span-7">
          {isLoading
            ? <Skeleton className="h-[332px] w-full" />
            : <FunnelChart data={data?.funnel ?? []} />}
        </div>
        <div className="xl:col-span-5">
          <Card>
            <CardHeader title="Разговоры по дням" />
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={trend} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: 'var(--fg-2)' }}
                  tickFormatter={d => d.slice(5)}
                  stroke="var(--line)"
                />
                <YAxis tick={{ fontSize: 10, fill: 'var(--fg-2)' }} stroke="var(--line)" />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    color: 'var(--fg-0)',
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone" dataKey="conversations"
                  stroke="var(--accent)" strokeWidth={1.5} dot={false}
                  name="Разговоры"
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>
    </div>
  );
}
