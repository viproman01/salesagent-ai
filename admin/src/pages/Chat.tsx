import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import api from '../api';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  time: string;
}

const SUGGESTIONS = [
  'Хочу букет жене на день рождения',
  'Что есть до 10 000 тенге?',
  'Какие розы в наличии?',
  'Сколько стоит доставка?',
];

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
      text: 'Здравствуйте. Я Айгуль, менеджер цветочного магазина в Алматы. Помогу подобрать букет и оформить доставку. Что ищете?',
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    setMessages(m => [...m, { role: 'user', text, time: now }]);
    setInput('');
    setLoading(true);

    try {
      const { data } = await api.post('/chat', { message: text, sessionId });
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
        text: `Ошибка: ${errMsg}`,
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

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] max-w-3xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-[15px] font-semibold text-fg-0">Чат с Айгуль</h1>
          <p className="text-[12px] text-fg-2 mt-0.5">Тестирование AI-агента в браузере</p>
        </div>
        <Button variant="secondary" size="sm" onClick={reset}>Новый разговор</Button>
      </div>

      <Card padding="none" className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, i) => {
            const fromUser = msg.role === 'user';
            return (
              <div key={i} className={`flex gap-2 ${fromUser ? 'flex-row-reverse' : ''}`}>
                <div className={`w-7 h-7 rounded-full grid place-items-center shrink-0 ${
                  fromUser ? 'bg-bg-2 text-fg-1' : 'bg-accent text-accent-fg'
                }`}>
                  {fromUser ? <User size={13} /> : <Bot size={13} />}
                </div>
                <div className={`max-w-[78%] ${fromUser ? 'items-end' : 'items-start'} flex flex-col`}>
                  <div className={
                    fromUser
                      ? 'px-3 py-2 rounded-3 rounded-br-sm text-[13px] whitespace-pre-wrap bg-bg-2 text-fg-0 border border-line'
                      : 'px-3 py-2 rounded-3 rounded-bl-sm text-[13px] whitespace-pre-wrap bg-accent/15 text-fg-0 border border-accent/30'
                  }>
                    {msg.text}
                  </div>
                  <span className="num text-[10px] text-fg-2 mt-1 px-1">{msg.time}</span>
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-accent text-accent-fg grid place-items-center shrink-0">
                <Bot size={13} />
              </div>
              <div className="bg-bg-2 rounded-3 rounded-bl-sm px-3 py-2 flex items-center gap-2 border border-line">
                <Loader2 size={12} className="animate-spin text-fg-2" />
                <span className="text-[12px] text-fg-2">Айгуль печатает…</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {messages.length <= 1 && (
          <div className="px-4 py-3 border-t border-line bg-bg-2/40">
            <div className="text-[10px] uppercase tracking-wider text-fg-2 mb-2">Попробуй</div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="text-[12px] px-2.5 h-7 rounded-full bg-bg-0 border border-line text-fg-1 hover:text-fg-0 hover:border-fg-2/30 transition-colors"
                >{s}</button>
              ))}
            </div>
          </div>
        )}

        <div className="p-3 border-t border-line">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Сообщение… ⌘+Enter — отправить"
              disabled={loading}
              rows={1}
              className="flex-1 bg-bg-1 border border-line rounded-2 p-2.5 text-[13px] resize-none min-h-[40px] max-h-[160px] text-fg-0 outline-none focus:border-accent disabled:opacity-50"
            />
            <Button
              onClick={() => void send()}
              disabled={loading || !input.trim()}
              size="md"
              iconLeft={<Send size={14} />}
            >Отпр.</Button>
          </div>
          <p className="text-[10px] text-fg-2 mt-2 text-center">
            AI может вызывать инструменты: search_knowledge, update_lead, book_meeting
          </p>
        </div>
      </Card>
    </div>
  );
}
