import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '../api';
import type { FunnelItem, TrendItem } from '../api';
import MetricCard from '../components/MetricCard';
import FunnelChart from '../components/FunnelChart';

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
  const { data, isLoading, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn:  () => api.get('/dashboard').then(r => r.data),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Загрузка метрик...
      </div>
    );
  }

  if (isError) {
    const message = (error as { response?: { data?: { message?: string; error?: string } }; message?: string })
      .response?.data?.message
      ?? (error as { response?: { data?: { error?: string } } }).response?.data?.error
      ?? 'Не удалось получить метрики.';
    return (
      <div className="mx-auto mt-12 max-w-xl rounded-2xl border border-red-200 bg-white p-7 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-gray-900">Дашборд временно недоступен</h1>
        <p className="mt-2 text-sm text-red-600">{message}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-5 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white"
        >
          Повторить
        </button>
      </div>
    );
  }

  const m = data?.metrics;
  const sub = data?.subscription;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Дашборд</h1>
        <p className="text-sm text-gray-500 mt-0.5">Метрики за последние 30 дней</p>
      </div>

      {/* Метрики */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title="Лиды" value={m?.totalLeads ?? 0} icon="👥" color="blue" />
        <MetricCard title="Разговоры" value={m?.totalConversations ?? 0} icon="💬" color="purple" />
        <MetricCard
          title="Конверсия"
          value={`${m?.conversionRate ?? 0}%`}
          icon="📈" color="green"
        />
        <MetricCard
          title="Ср. ответ"
          value={m?.avgResponseTimeMs ? `${((m.avgResponseTimeMs) / 1000).toFixed(1)}с` : '—'}
          icon="⚡" color="orange"
        />
      </div>

      {/* Подписка */}
      {sub && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700 capitalize">
              План: <span className="text-brand-600">{sub.plan}</span>
            </span>
            <span className="text-xs text-gray-400">
              {sub.messages_used.toLocaleString()} / {sub.messages_limit.toLocaleString()} сообщений
            </span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className="bg-brand-500 h-2 rounded-full transition-all"
              style={{ width: `${Math.min(100, (sub.messages_used / sub.messages_limit) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Воронка */}
        {data?.funnel && <FunnelChart data={data.funnel} />}

        {/* Тренд */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-4">Разговоры по дням</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data?.trend ?? []} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={d => d.slice(5)}
              />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
              />
              <Line
                type="monotone" dataKey="conversations"
                stroke="#4f6ef7" strokeWidth={2} dot={false}
                name="Разговоры"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
