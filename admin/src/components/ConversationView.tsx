import { useQuery } from '@tanstack/react-query';
import api, { type Message } from '../api';
import AudioPlayer from './AudioPlayer';
import { Bot, User, Wrench, X } from 'lucide-react';

interface Props {
  convId: string;
  onClose?: () => void;
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  user:      <User size={12} />,
  assistant: <Bot  size={12} />,
  tool:      <Wrench size={12} />,
};

export default function ConversationView({ convId, onClose }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['conv-messages', convId],
    queryFn:  () => api.get(`/conversations/${convId}/messages`).then(r => r.data as {
      messages: Message[];
      recording: { id: string; duration_seconds: number; transcript: string } | null;
    }),
  });

  const { data: audioData } = useQuery({
    queryKey: ['recording-audio', data?.recording?.id],
    queryFn:  () => data?.recording
      ? api.get(`/recordings/${data.recording.id}/audio`).then(r => r.data as { url: string; duration: number })
      : null,
    enabled:  !!data?.recording?.id,
  });

  return (
    <div className="flex flex-col h-full bg-bg-0">
      <div className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-line bg-bg-1">
        <h3 className="text-[13px] font-semibold text-fg-0">Разговор</h3>
        {onClose && (
          <button onClick={onClose} className="text-fg-2 hover:text-fg-0">
            <X size={16} />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-fg-2 text-[13px]">Загрузка…</div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {data?.messages.map(msg => {
            const fromUser = msg.role === 'user';
            return (
              <div key={msg.id} className={`flex flex-col max-w-[78%] ${fromUser ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
                <div className="flex items-center gap-1 text-[10px] text-fg-2 mb-1 uppercase tracking-wider">
                  {ROLE_ICONS[msg.role]}
                  <span>{msg.role}</span>
                  {msg.latency_ms && <span>· {msg.latency_ms}ms</span>}
                </div>
                <div className={
                  fromUser
                    ? 'rounded-3 px-3 py-2 text-[13px] bg-bg-2 text-fg-0 border border-line'
                    : msg.role === 'tool'
                      ? 'rounded-3 px-3 py-2 text-[12px] bg-warn/10 text-fg-0 border border-warn/30 font-mono'
                      : 'rounded-3 px-3 py-2 text-[13px] bg-accent/15 text-fg-0 border border-accent/30'
                }>
                  {msg.content ?? (
                    msg.tool_name ? (
                      <div>
                        <div className="font-semibold text-[12px]">{msg.tool_name}</div>
                        <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words">{JSON.stringify(msg.tool_input, null, 2)}</pre>
                      </div>
                    ) : '—'
                  )}
                </div>
                <span className="num text-[10px] text-fg-2 mt-0.5">
                  {new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            );
          })}
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
