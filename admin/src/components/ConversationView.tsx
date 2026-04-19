import { useQuery } from '@tanstack/react-query';
import api, { type Message } from '../api';
import AudioPlayer from './AudioPlayer';
import { Bot, User, Wrench, X } from 'lucide-react';

interface Props {
  convId: string;
  onClose: () => void;
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  user:      <User size={14} />,
  assistant: <Bot  size={14} />,
  tool:      <Wrench size={14} />,
};

const ROLE_COLORS: Record<string, string> = {
  user:      'bg-gray-100 text-gray-800 self-end',
  assistant: 'bg-brand-50 text-brand-900 self-start border border-brand-200',
  tool:      'bg-orange-50 text-orange-800 self-start font-mono text-xs border border-orange-200',
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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-semibold text-gray-900">Разговор</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X size={20} />
        </button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">Загрузка...</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {data?.messages.map(msg => (
            <div key={msg.id} className={`flex flex-col max-w-[80%] ${
              msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
            }`}>
              <div className={`flex items-center gap-1 text-xs text-gray-400 mb-1`}>
                {ROLE_ICONS[msg.role]}
                <span>{msg.role}</span>
                {msg.latency_ms && <span>· {msg.latency_ms}ms</span>}
              </div>
              <div className={`rounded-xl px-3 py-2 text-sm ${ROLE_COLORS[msg.role] ?? 'bg-gray-100'}`}>
                {msg.content ?? (
                  msg.tool_name ? (
                    <div>
                      <div className="font-semibold">{msg.tool_name}</div>
                      <pre className="mt-1 text-xs">{JSON.stringify(msg.tool_input, null, 2)}</pre>
                    </div>
                  ) : '—'
                )}
              </div>
              <span className="text-xs text-gray-300 mt-0.5">
                {new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      )}

      {audioData && data?.recording && (
        <div className="p-4 border-t">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Запись звонка</h4>
          <AudioPlayer url={audioData.url} duration={audioData.duration} />
          {data.recording.transcript && (
            <div className="mt-3 text-xs text-gray-500 bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto">
              {data.recording.transcript}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
