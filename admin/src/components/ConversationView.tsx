import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Bot,
  Headphones,
  Loader2,
  Send,
  User,
  Wrench,
  X,
} from 'lucide-react';
import api, { type Message } from '../api';
import AudioPlayer from './AudioPlayer';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { toast } from '../ui/Toast';

interface Props {
  convId: string;
  onClose?: () => void;
}

interface ConversationDetail {
  org_id: string;
  channel: string;
  status: string;
  reply_mode: 'ai' | 'operator';
  mode_version: number;
  phone: string | null;
  whatsapp_jid: string | null;
  whatsapp_opted_out: boolean;
  whatsapp_handoff: boolean;
}

interface DetailResponse {
  messages: Message[];
  recording: { id: string; duration_seconds: number; transcript: string } | null;
  conversation: ConversationDetail;
  limits?: {
    whatsappOutboundMaxChars?: number;
  };
}

interface OperatorReplyRequest {
  text: string;
  clientRequestId: string;
}

interface OperatorReplyResponse {
  deliveryStatus?: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  customer: <User size={12} />,
  ai: <Bot size={12} />,
  operator: <Headphones size={12} />,
  system: <Wrench size={12} />,
};

const ROLE_LABELS: Record<string, string> = {
  customer: 'Клиент',
  ai: 'AI',
  operator: 'Оператор',
  system: 'Система',
};

const DELIVERY_LABELS: Partial<Record<Message['delivery_status'], string>> = {
  pending: 'ожидает отправки',
  sending: 'отправляется',
  failed: 'не отправлено',
  cancelled: 'отменено',
};

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  const data = error.response?.data as { error?: unknown } | undefined;
  return typeof data?.error === 'string' && data.error.trim()
    ? data.error
    : fallback;
}

export default function ConversationView({ convId, onClose }: Props) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const replyRequestIdRef = useRef(crypto.randomUUID());
  const endRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['conv-messages', convId],
    queryFn: () => api
      .get(`/conversations/${convId}/messages`)
      .then(response => response.data as DetailResponse),
    refetchInterval: 5_000,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['conv-messages', convId] }),
      queryClient.invalidateQueries({ queryKey: ['conversations'] }),
    ]);
  };

  const modeMutation = useMutation({
    mutationFn: (mode: 'ai' | 'operator') => api.patch(
      `/conversations/${convId}/reply-mode`,
      { mode, expectedVersion: data!.conversation.mode_version }
    ),
    onSuccess: async (_response, mode) => {
      toast.success(mode === 'ai' ? 'AI-ответы включены' : 'Диалог передан оператору');
      await refresh();
    },
    onError: async error => {
      toast.error(apiErrorMessage(error, 'Не удалось изменить режим. Данные обновлены.'));
      await refresh();
    },
  });

  const resetReply = (): void => {
    setReply('');
    replyRequestIdRef.current = crypto.randomUUID();
  };

  const replyMutation = useMutation({
    mutationFn: ({ text, clientRequestId }: OperatorReplyRequest) => api.post<OperatorReplyResponse>(
      `/conversations/${convId}/replies`,
      {
      text,
      clientRequestId,
      expectedVersion: data!.conversation.mode_version,
      },
    ),
    onSuccess: async response => {
      const deliveryStatus = response.data.deliveryStatus;
      if (deliveryStatus === 'failed') {
        toast.error('Ответ не отправлен. Текст сохранён — можно повторить.');
        await refresh();
        return;
      }
      if (deliveryStatus === 'cancelled') {
        replyRequestIdRef.current = crypto.randomUUID();
        toast.error('Отправка отменена из-за изменения режима. Текст сохранён.');
        await refresh();
        return;
      }

      resetReply();
      if (deliveryStatus === 'pending' || deliveryStatus === 'sending') {
        toast.info('Ответ принят в очередь и ожидает отправки.');
      } else {
        toast.success('Ответ оператора отправлен.');
      }
      await refresh();
    },
    onError: async error => {
      toast.error(apiErrorMessage(
        error,
        'Не удалось отправить ответ. Проверьте режим и подключение WhatsApp.',
      ));
      await refresh();
    },
  });

  const { data: audioData } = useQuery({
    queryKey: ['recording-audio', data?.recording?.id],
    queryFn: () => data?.recording
      ? api.get(`/recordings/${data.recording.id}/audio`).then(response =>
          response.data as { url: string; duration: number }
        )
      : null,
    enabled: Boolean(data?.recording?.id),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.messages.length]);

  useEffect(() => {
    resetReply();
  }, [convId]);

  const conversation = data?.conversation;
  const isWhatsApp = conversation?.channel === 'whatsapp';
  const operatorMode = conversation?.reply_mode === 'operator';
  const optedOut = Boolean(conversation?.whatsapp_opted_out);
  const conversationActive = conversation?.status === 'active';
  const configuredOutboundLimit = data?.limits?.whatsappOutboundMaxChars;
  const outboundMaxChars = typeof configuredOutboundLimit === 'number' && configuredOutboundLimit > 0
    ? configuredOutboundLimit
    : 4_096;

  const updateReply = (nextReply: string): void => {
    setReply(nextReply);
    replyRequestIdRef.current = crypto.randomUUID();
  };

  const sendReply = (): void => {
    const text = reply.trim();
    if (!text || replyMutation.isPending || text.length > outboundMaxChars) return;
    replyMutation.mutate({
      text,
      clientRequestId: replyRequestIdRef.current,
    });
  };

  return (
    <div className="flex flex-col h-full bg-bg-0">
      <div className="min-h-12 shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-b border-line bg-bg-1">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-[13px] font-semibold text-fg-0">Разговор</h3>
          {isWhatsApp && conversation && (
            <>
              <Badge tone={optedOut ? 'danger' : operatorMode ? 'warn' : 'ok'} size="sm">
                {optedOut ? 'STOP' : operatorMode ? 'Оператор' : 'AI отвечает'}
              </Badge>
              <div className="flex rounded-2 border border-line overflow-hidden">
                <button
                  type="button"
                  disabled={modeMutation.isPending || optedOut || !conversationActive || !operatorMode}
                  onClick={() => modeMutation.mutate('ai')}
                  className={`h-7 px-2 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed ${!operatorMode && !optedOut ? 'bg-accent text-accent-fg' : 'bg-bg-2 text-fg-1'}`}
                >
                  AI
                </button>
                <button
                  type="button"
                  disabled={modeMutation.isPending || optedOut || !conversationActive || operatorMode}
                  onClick={() => modeMutation.mutate('operator')}
                  className={`h-7 px-2 text-[11px] border-l border-line disabled:opacity-50 disabled:cursor-not-allowed ${operatorMode && !optedOut ? 'bg-warn/20 text-warn' : 'bg-bg-2 text-fg-1'}`}
                >
                  Оператор
                </button>
              </div>
            </>
          )}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-fg-2 hover:text-fg-0">
            <X size={16} />
          </button>
        )}
      </div>

      {optedOut && (
        <div className="px-4 py-2 text-[12px] text-danger bg-danger/10 border-b border-danger/20">
          Клиент отключил ответы командой STOP. Отправка заблокирована до входящей команды «СТАРТ».
        </div>
      )}

      {isWhatsApp && conversation && !conversationActive && (
        <div className="px-4 py-2 text-[12px] text-warn bg-warn/10 border-b border-warn/20">
          Диалог завершён. Исходящие сообщения и смена режима отключены.
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-fg-2 text-[13px]">
          Загрузка…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {data?.messages.map(message => {
            const sender = message.sender_type ??
              (message.role === 'user' ? 'customer' : message.role === 'assistant' ? 'ai' : 'system');
            const fromCustomer = sender === 'customer';
            const delivery = DELIVERY_LABELS[message.delivery_status];
            return (
              <div
                key={message.id}
                className={`flex flex-col max-w-[78%] ${fromCustomer ? 'ml-auto items-end' : 'mr-auto items-start'}`}
              >
                <div className="flex items-center gap-1 text-[10px] text-fg-2 mb-1 uppercase tracking-wider">
                  {ROLE_ICONS[sender]}
                  <span>{ROLE_LABELS[sender] ?? sender}</span>
                  {message.latency_ms ? <span>· {message.latency_ms}ms</span> : null}
                  {delivery ? <span className={message.delivery_status === 'failed' ? 'text-danger' : ''}>· {delivery}</span> : null}
                </div>
                <div className={
                  fromCustomer
                    ? 'rounded-3 px-3 py-2 text-[13px] bg-bg-2 text-fg-0 border border-line'
                    : sender === 'operator'
                      ? 'rounded-3 px-3 py-2 text-[13px] bg-warn/10 text-fg-0 border border-warn/30'
                      : sender === 'system'
                        ? 'rounded-3 px-3 py-2 text-[12px] bg-bg-2 text-fg-1 border border-line font-mono'
                        : 'rounded-3 px-3 py-2 text-[13px] bg-accent/15 text-fg-0 border border-accent/30'
                }>
                  {message.content ?? '—'}
                </div>
                <span className="num text-[10px] text-fg-2 mt-0.5">
                  {new Date(message.created_at).toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {isWhatsApp && operatorMode && !optedOut && conversationActive && (
        <div className="p-3 border-t border-line bg-bg-1">
          <div className="flex gap-2 items-end">
            <textarea
              value={reply}
              onChange={event => updateReply(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendReply();
                }
              }}
              disabled={replyMutation.isPending}
              placeholder="Ответ оператора…"
              rows={2}
              maxLength={outboundMaxChars}
              className="flex-1 bg-bg-0 border border-line rounded-2 p-2.5 text-[13px] resize-none text-fg-0 outline-none focus:border-accent disabled:opacity-50"
            />
            <Button
              onClick={sendReply}
              disabled={!reply.trim() || replyMutation.isPending || reply.trim().length > outboundMaxChars}
              iconLeft={replyMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            >
              Отправить
            </Button>
          </div>
          <p className="text-[10px] text-fg-2 mt-1">
            Адресат берётся из подтверждённого входящего WhatsApp-диалога; произвольная рассылка отключена.
            {' '}Лимит: {outboundMaxChars} символов.
          </p>
        </div>
      )}

      {audioData && data?.recording && (
        <div className="p-4 border-t border-line bg-bg-1">
          <h4 className="text-[11px] uppercase tracking-wider text-fg-2 mb-2">Запись звонка</h4>
          <AudioPlayer url={audioData.url} duration={audioData.duration} />
          {data.recording.transcript && (
            <div className="mt-3 text-[12px] text-fg-1 bg-bg-2 rounded-2 p-3 max-h-32 overflow-y-auto border border-line">
              {data.recording.transcript}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
