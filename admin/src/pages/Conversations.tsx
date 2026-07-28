import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import type { Conversation } from '../api';
import ConversationView from '../components/ConversationView';
import { MessageSquare, MessagesSquare, Mic, Send } from 'lucide-react';

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  whatsapp: <Send size={14} className="text-green-500" />,
  telegram: <MessageSquare size={14} className="text-blue-500" />,
  voice:    <Mic size={14} className="text-purple-500" />,
  chat:     <MessagesSquare size={14} className="text-brand-500" />,
};

const STATUS_COLORS: Record<string, string> = {
  active:    'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-600',
  failed:    'bg-red-100 text-red-700',
  timeout:   'bg-yellow-100 text-yellow-700',
};

const STAGE_LABELS: Record<string, string> = {
  new: 'Новый', contacted: 'Контакт', interested: 'Интерес',
  objection: 'Возражение', negotiation: 'Переговоры',
  meeting_booked: 'Встреча', closed_won: 'Закрыт ✓',
  closed_lost: 'Потерян', nurturing: 'Прогрев',
};

export default function Conversations() {
  const orgId = localStorage.getItem('orgId') ?? '';
  const [channel, setChannel]   = useState('');
  const [status, setStatus]     = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['conversations', orgId, channel, status],
    queryFn:  () => api.get(`/conversations/${orgId}`, {
      params: { channel: channel || undefined, status: status || undefined, limit: 50 },
    }).then(r => r.data as { conversations: Conversation[]; total: number }),
  });

  return (
    <div className="flex gap-4 h-[calc(100vh-6rem)]">
      {/* Список */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-gray-900">
            Разговоры {data && <span className="text-sm font-normal text-gray-400">({data.total})</span>}
          </h1>
          <div className="flex gap-2">
            <select
              value={channel} onChange={e => setChannel(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Все каналы</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
              <option value="voice">Голос</option>
              <option value="chat">Веб-чат</option>
            </select>
            <select
              value={status} onChange={e => setStatus(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Все статусы</option>
              <option value="active">Активные</option>
              <option value="completed">Завершённые</option>
              <option value="failed">Ошибка</option>
            </select>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-gray-400">Загрузка...</div>
          ) : data?.conversations.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-400">Нет разговоров</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Клиент</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Канал</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Этап</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Статус</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Сообщ.</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Время</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data?.conversations.map(conv => (
                  <tr
                    key={conv.id}
                    onClick={() => setSelectedId(conv.id === selectedId ? null : conv.id)}
                    className={`cursor-pointer hover:bg-gray-50 transition-colors ${
                      conv.id === selectedId ? 'bg-brand-50' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{conv.lead_name ?? conv.phone}</div>
                      <div className="text-xs text-gray-400">{conv.phone}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {CHANNEL_ICONS[conv.channel]}
                        <span className="capitalize">{conv.channel}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {STAGE_LABELS[conv.lead_stage] ?? conv.lead_stage}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[conv.status] ?? ''}`}>
                        {conv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{conv.message_count}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(conv.started_at).toLocaleDateString('ru-RU', {
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Боковая панель с деталями */}
      {selectedId && (
        <div className="w-96 bg-white rounded-xl border border-gray-200 shadow-sm shrink-0 overflow-hidden flex flex-col">
          <ConversationView convId={selectedId} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}
