import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Bot, Loader2, Send, User } from 'lucide-react';
import api from '../api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: string;
}

interface ChatStatusResponse {
  enabled: boolean;
  ready: boolean;
  agentName: string | null;
}

interface ChatHistoryResponse {
  conversationId: string | null;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
}

interface ChatReplyResponse {
  reply: string;
}

const SUGGESTIONS = [
  'Хочу букет жене на день рождения',
  'Что есть до 10 000 тенге?',
  'Какие розы в наличии?',
  'Сколько стоит доставка?',
];

function formatTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function greeting(): Message {
  return {
    id: 'local-greeting',
    role: 'assistant',
    text: 'Здравствуйте. Я Айгуль — AI-ассистент цветочного магазина в Алматы. Помогу подобрать букет и оформить доставку. Что ищете?',
    time: formatTime(new Date()),
  };
}

function isNotFound(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}

export default function Chat() {
  const [sessionId] = useState(() => {
    const stored = sessionStorage.getItem('chat_session');
    if (stored) return stored;
    const id = crypto.randomUUID();
    sessionStorage.setItem('chat_session', id);
    return id;
  });
  const [messages, setMessages] = useState<Message[]>(() => [greeting()]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const historyAppliedRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const statusQuery = useQuery({
    queryKey: ['chat-status'],
    queryFn: async (): Promise<ChatStatusResponse | null> => {
      try {
        const response = await api.get<ChatStatusResponse>('/chat/status');
        return response.data;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    refetchInterval: 15_000,
    retry: 1,
  });

  const historyQuery = useQuery({
    queryKey: ['chat-history', sessionId],
    queryFn: async (): Promise<ChatHistoryResponse | null> => {
      try {
        const response = await api.get<ChatHistoryResponse>(
          `/chat/${encodeURIComponent(sessionId)}/history`,
        );
        return response.data;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    retry: 1,
  });

  useEffect(() => {
    if (!historyQuery.isSuccess || historyAppliedRef.current) return;
    historyAppliedRef.current = true;
    if (!historyQuery.data?.messages.length) return;
    setMessages(historyQuery.data.messages.map(message => ({
      id: message.id,
      role: message.role,
      text: message.content,
      time: formatTime(message.createdAt),
    })));
  }, [historyQuery.data, historyQuery.isSuccess]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const status = statusQuery.data;
  const explicitlyUnavailable = Boolean(status && (!status.enabled || !status.ready));
  const canSend = !loading && !historyQuery.isLoading && !explicitlyUnavailable;
  const assistantName = status?.agentName?.trim() || 'Айгуль';

  let readinessLabel = 'Статус не подтверждён';
  let readinessTone: 'neutral' | 'ok' | 'warn' | 'danger' = 'neutral';
  let readinessDetail = 'Статус-маршрут недоступен; фактическая готовность проверится при отправке.';
  if (statusQuery.isLoading) {
    readinessLabel = 'Проверка…';
    readinessDetail = 'Проверяем AI-агента.';
  } else if (status?.enabled && status.ready) {
    readinessLabel = 'Автоответ включён';
    readinessTone = 'ok';
    readinessDetail = `AI-агент «${assistantName}» готов отвечать.`;
  } else if (status && !status.enabled) {
    readinessLabel = 'Автоответ выключен';
    readinessTone = 'danger';
    readinessDetail = 'Включите TEXT_CHAT_ENABLED на сервере.';
  } else if (status && !status.ready) {
    readinessLabel = 'AI не готов';
    readinessTone = 'warn';
    readinessDetail = 'Нет активного агента или провайдер ещё не готов.';
  } else if (statusQuery.isError) {
    readinessLabel = 'Статус недоступен';
    readinessTone = 'warn';
    readinessDetail = 'Не удалось проверить готовность AI.';
  }

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || !canSend) return;

    setMessages(current => [...current, {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      time: formatTime(new Date()),
    }]);
    setInput('');
    setLoading(true);

    try {
      const { data } = await api.post<ChatReplyResponse>('/chat', { message: text, sessionId });
      setMessages(current => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: data.reply,
        time: formatTime(new Date()),
      }]);
      void statusQuery.refetch();
    } catch (error: unknown) {
      const errorMessage = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error ? error.message : 'Неизвестная ошибка';
      setMessages(current => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Ошибка: ${errorMessage}`,
        time: formatTime(new Date()),
      }]);
      void statusQuery.refetch();
    } finally {
      setLoading(false);
    }
  };

  const reset = (): void => {
    sessionStorage.removeItem('chat_session');
    window.location.reload();
  };

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] max-w-3xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[15px] font-semibold text-fg-0">Чат с AI-ассистентом {assistantName}</h1>
            <Badge tone={readinessTone} size="sm">{readinessLabel}</Badge>
          </div>
          <p className="text-[12px] text-fg-2 mt-0.5">{readinessDetail}</p>
          {historyQuery.isError && (
            <p className="text-[11px] text-warn mt-0.5">Историю не удалось загрузить.</p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={reset}>Новый разговор</Button>
      </div>

      <Card padding="none" className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {historyQuery.isLoading && (
            <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-fg-2">
              <Loader2 size={14} className="animate-spin" />
              Загружаем историю…
            </div>
          )}
          {!historyQuery.isLoading && messages.map(message => {
            const fromUser = message.role === 'user';
            return (
              <div key={message.id} className={`flex gap-2 ${fromUser ? 'flex-row-reverse' : ''}`}>
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
                    {message.text}
                  </div>
                  <span className="num text-[10px] text-fg-2 mt-1 px-1">{message.time}</span>
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
                <span className="text-[12px] text-fg-2">{assistantName} печатает…</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {messages.length <= 1 && !historyQuery.isLoading && (
          <div className="px-4 py-3 border-t border-line bg-bg-2/40">
            <div className="text-[10px] uppercase tracking-wider text-fg-2 mb-2">Попробуй</div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map(suggestion => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  disabled={!canSend}
                  className="text-[12px] px-2.5 h-7 rounded-full bg-bg-0 border border-line text-fg-1 hover:text-fg-0 hover:border-fg-2/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="p-3 border-t border-line">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={explicitlyUnavailable ? 'Автоответ сейчас недоступен' : 'Сообщение… Enter — отправить'}
              disabled={!canSend}
              rows={1}
              className="flex-1 bg-bg-1 border border-line rounded-2 p-2.5 text-[13px] resize-none min-h-[40px] max-h-[160px] text-fg-0 outline-none focus:border-accent disabled:opacity-50"
            />
            <Button
              onClick={() => void send()}
              disabled={!canSend || !input.trim()}
              size="md"
              iconLeft={<Send size={14} />}
            >
              Отпр.
            </Button>
          </div>
          <p className="text-[10px] text-fg-2 mt-2 text-center">
            Вы общаетесь с AI-ассистентом. История сохраняется в разделе «Разговоры».
          </p>
        </div>
      </Card>
    </div>
  );
}
