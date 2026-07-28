import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import api, { type Agent } from '../api';
import { Send, Bot, User, Loader2, AlertCircle } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  time: string;
}

export default function Chat() {
  const [sessionId] = useState(() => {
    const stored = sessionStorage.getItem('chat_session');
    if (stored) return stored;
    const id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('chat_session', id);
    return id;
  });

  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      text: 'Тестовый чат готов. Выберите агента и напишите сообщение клиента.',
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput] = useState('');
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get('/agents').then(response => response.data as { agents: Agent[] }),
  });
  const agents = agentsData?.agents.filter(agent => agent.is_active) ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading || !agentId) return;

    const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    setMessages(m => [...m, { role: 'user', text, time: now }]);
    setInput('');
    setLoading(true);

    try {
      const { data } = await api.post('/chat', { agentId, message: text, sessionId });
      setMessages(m => [...m, {
        role: 'assistant',
        text: data.reply,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      }]);
    } catch (err: unknown) {
      const errMsg = (err as { response?: { data?: { error?: string } }; message?: string }).response?.data?.error
        ?? (err as Error).message;
      setMessages(m => [...m, {
        role: 'assistant',
        text: `❌ Ошибка: ${errMsg}`,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      }]);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    sessionStorage.removeItem('chat_session');
    window.location.reload();
  };

  const SUGGESTIONS = [
    'Расскажите о ваших товарах',
    'Сколько стоит доставка?',
    'Помогите выбрать подходящий вариант',
    'Можно записаться на консультацию?',
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Чат с агентом</h1>
          <p className="text-sm text-gray-500 mt-0.5">Тот же RAG и инструменты, что в каналах продаж</p>
        </div>
        <button
          onClick={reset}
          className="text-xs text-gray-500 hover:text-gray-900 px-3 py-1.5 border border-gray-200 rounded-lg"
        >
          Новый разговор
        </button>
      </div>

      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <label className="mb-1 block text-xs font-medium text-gray-600">Активный агент</label>
        <select
          value={agentId}
          onChange={event => setAgentId(event.target.value)}
          disabled={agentsLoading || loading}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Выберите агента</option>
          {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} — {agent.model_text}</option>)}
        </select>
        {!agentsLoading && agents.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-yellow-700">
            <AlertCircle size={15} /> Сначала <a className="font-semibold underline" href="/agents">создайте активного агента</a>.
          </p>
        ) : null}
      </div>

      {/* Чат */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                msg.role === 'user' ? 'bg-gray-200 text-gray-600' : 'bg-brand-500 text-white'
              }`}>
                {msg.role === 'user' ? <User size={15} /> : <Bot size={15} />}
              </div>
              <div className={`max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
                <div className={`px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-brand-500 text-white rounded-br-sm'
                    : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                }`}>
                  {msg.text}
                </div>
                <span className="text-xs text-gray-400 mt-1 px-2">{msg.time}</span>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-brand-500 text-white flex items-center justify-center shrink-0">
                <Bot size={15} />
              </div>
              <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-gray-400" />
                <span className="text-sm text-gray-400">Агент отвечает...</span>
              </div>
            </div>
          )}

          <div ref={endRef} />
        </div>

        {/* Подсказки */}
        {messages.length <= 1 && (
          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
            <div className="text-xs text-gray-500 mb-2">Попробуйте:</div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="text-xs px-3 py-1.5 bg-white border border-gray-200 rounded-full hover:bg-brand-50 hover:border-brand-200 hover:text-brand-700 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="p-4 border-t border-gray-100">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Напишите сообщение..."
              disabled={loading || !agentId}
              className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
            />
            <button
              onClick={() => void send()}
              disabled={loading || !input.trim() || !agentId}
              className="w-11 h-11 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-xl flex items-center justify-center transition-colors shrink-0"
            >
              <Send size={17} />
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">
            AI может вызывать инструменты: search_knowledge, update_lead, book_meeting
          </p>
        </div>
      </div>
    </div>
  );
}
