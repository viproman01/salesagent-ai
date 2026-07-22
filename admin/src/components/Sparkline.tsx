import { LineChart, Line, ResponsiveContainer } from 'recharts';

export default function Sparkline({ data, color = 'var(--accent)' }: { data: number[]; color?: string }) {
  const pts = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-9">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={pts}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
