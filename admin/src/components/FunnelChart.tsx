import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import type { FunnelItem } from '../api';

const STAGE_LABELS: Record<string, string> = {
  new:           'Новые',
  contacted:     'Контакт',
  interested:    'Интерес',
  objection:     'Возражение',
  negotiation:   'Переговоры',
  meeting_booked:'Встреча',
  closed_won:    'Закрыт ✓',
  closed_lost:   'Потерян',
  nurturing:     'Прогрев',
};

const STAGE_COLORS: Record<string, string> = {
  new:           '#94a3b8',
  contacted:     '#60a5fa',
  interested:    '#34d399',
  objection:     '#f87171',
  negotiation:   '#a78bfa',
  meeting_booked:'#fbbf24',
  closed_won:    '#10b981',
  closed_lost:   '#ef4444',
  nurturing:     '#fb923c',
};

interface Props { data: FunnelItem[] }

export default function FunnelChart({ data }: Props) {
  const chartData = data.map(item => ({
    name:  STAGE_LABELS[item.stage] ?? item.stage,
    stage: item.stage,
    count: parseInt(item.count),
  }));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <h3 className="font-semibold text-gray-900 mb-4">Воронка продаж</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 20 }}>
          <XAxis type="number" tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={90} />
          <Tooltip
            formatter={(v: number) => [v, 'Лиды']}
            contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={32}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={STAGE_COLORS[entry.stage] ?? '#94a3b8'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
