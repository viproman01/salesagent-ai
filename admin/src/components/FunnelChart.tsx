import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import type { FunnelItem } from '../api';
import { Card, CardHeader } from '../ui/Card';

const STAGE_LABELS: Record<string, string> = {
  new:           'Новые',
  contacted:     'Контакт',
  interested:    'Интерес',
  objection:     'Возражение',
  negotiation:   'Переговоры',
  meeting_booked:'Встреча',
  closed_won:    'Закрыт',
  closed_lost:   'Потерян',
  nurturing:     'Прогрев',
};

const STAGE_COLORS: Record<string, string> = {
  new:           '#6b7280',
  contacted:     '#60a5fa',
  interested:    '#34d399',
  objection:     '#f87171',
  negotiation:   '#a78bfa',
  meeting_booked:'#fbbf24',
  closed_won:    '#00b14f',
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
    <Card>
      <CardHeader title="Воронка продаж" />
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 20 }}>
          <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--fg-2)' }} stroke="var(--line)" />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--fg-1)' }} width={90} stroke="var(--line)" />
          <Tooltip
            formatter={(v: number) => [v, 'Лиды']}
            cursor={{ fill: 'rgba(255,255,255,.03)' }}
            contentStyle={{
              background: 'var(--bg-2)',
              border:     '1px solid var(--line)',
              borderRadius: '6px',
              color: 'var(--fg-0)',
              fontSize: 12,
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={STAGE_COLORS[entry.stage] ?? '#6b7280'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
