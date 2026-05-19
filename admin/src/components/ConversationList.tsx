import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Mic, MessageSquare, Send } from 'lucide-react';
import type { Conversation } from '../api';
import { cn } from '../ui/cn';
import { Skeleton } from '../ui/Skeleton';

interface Props {
  items: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
}

const CHANNEL_ICON: Record<string, JSX.Element> = {
  whatsapp: <Send size={11} className="text-ok" />,
  telegram: <MessageSquare size={11} className="text-[#60a5fa]" />,
  voice:    <Mic size={11} className="text-accent" />,
};

const STAGE_LABEL: Record<string, string> = {
  new: 'Новый', contacted: 'Контакт', interested: 'Интерес',
  objection: 'Возражение', negotiation: 'Переговоры',
  meeting_booked: 'Встреча', closed_won: 'Закрыт', closed_lost: 'Потерян',
  nurturing: 'Прогрев',
};

export default function ConversationList({ items, selectedId, onSelect, loading }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68,
    overscan: 8,
  });

  if (loading) {
    return <div className="p-2 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  }

  if (items.length === 0) {
    return <div className="p-6 text-center text-fg-2 text-[13px]">Нет разговоров</div>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map(row => {
          const c = items[row.index];
          const active = c.id === selectedId;
          const name = c.lead_name ?? c.phone;
          const initials = (name ?? '?').slice(0, 2).toUpperCase();
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)`, height: row.size }}
              className={cn(
                'w-full flex items-start gap-3 px-3 py-2 text-left border-b border-line transition-colors',
                active ? 'bg-bg-2' : 'hover:bg-bg-2/60'
              )}
            >
              <div className="w-9 h-9 rounded-full bg-accent/20 text-accent grid place-items-center text-[12px] font-medium shrink-0">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-medium text-fg-0 truncate">{name}</div>
                  <div className="num text-[10px] text-fg-2 shrink-0">{fmtTime(c.last_message_at ?? c.started_at)}</div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-fg-1 truncate">
                    {CHANNEL_ICON[c.channel]}
                    <span className="text-fg-2">·</span>
                    <span className="truncate">{STAGE_LABEL[c.lead_stage] ?? c.lead_stage}</span>
                  </div>
                  <span className="num text-[10px] text-fg-2 shrink-0">{c.message_count} msg</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
