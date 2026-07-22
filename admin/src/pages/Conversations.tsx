import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import api, { type Conversation } from '../api';
import ConversationView from '../components/ConversationView';
import ConversationList from '../components/ConversationList';
import ChipFilterRow from '../components/ChipFilterRow';
import { Input } from '../ui/Input';
import { EmptyState } from '../ui/EmptyState';

const CHANNELS = [
  { key: 'whatsapp',  label: 'WhatsApp' },
  { key: 'telegram',  label: 'Telegram' },
  { key: 'voice',     label: 'Voice' },
  { key: 'webchat',   label: 'Веб-чат' },
];

export default function Conversations() {
  const orgId = localStorage.getItem('orgId') ?? '';
  const [channel, setChannel] = useState<string | null>(null);
  const [search,  setSearch]  = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['conversations', orgId, channel],
    queryFn:  () => api.get(`/conversations/${orgId}`, {
      params: { channel: channel ?? undefined, limit: 200 },
    }).then(r => r.data as { conversations: Conversation[]; total: number }),
    refetchInterval: 5_000,
  });

  const items = useMemo(() => {
    const raw = data?.conversations ?? [];
    if (!search.trim()) return raw;
    const q = search.toLowerCase();
    return raw.filter(c =>
      (c.lead_name ?? '').toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      <aside className="w-[380px] flex flex-col border-r border-line bg-bg-1 shrink-0">
        <div className="p-2 border-b border-line">
          <Input
            placeholder="Поиск разговоров…"
            leftSlot={<Search size={13} className="text-fg-2" />}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <ChipFilterRow chips={CHANNELS} value={channel} onChange={setChannel} />
        <div className="flex-1 min-h-0">
          <ConversationList
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={isLoading}
          />
        </div>
      </aside>
      <section className="flex-1 min-w-0">
        {selectedId
          ? <ConversationView convId={selectedId} onClose={() => setSelectedId(null)} />
          : <EmptyState
              title="Выбери разговор"
              description="Кликни строку слева, чтобы открыть переписку."
              className="h-full"
            />}
      </section>
    </div>
  );
}
