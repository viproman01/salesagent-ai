import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mic, Clock, Search } from 'lucide-react';
import api from '../api';
import type { Recording } from '../api';
import AudioPlayer from '../components/AudioPlayer';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';

const HIGHLIGHT_TONE: Record<string, 'danger' | 'ok' | 'warn' | 'neutral'> = {
  objection: 'danger',
  agreement: 'ok',
  pricing:   'warn',
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Recordings() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl]     = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Array<{ time_ms: number; type: string; text: string }>>([]);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['recordings'],
    queryFn:  () => api.get('/recordings').then(r => r.data as { recordings: Recording[] }),
  });

  const selectRecording = async (rec: Recording) => {
    setSelectedId(rec.id);
    setAudioUrl(null);
    setTranscript(null);
    setHighlights([]);
    const [audioResp, transcriptResp] = await Promise.all([
      api.get(`/recordings/${rec.id}/audio`),
      api.get(`/recordings/${rec.id}/transcript`),
    ]);
    setAudioUrl(audioResp.data.url);
    setTranscript(transcriptResp.data.transcript);
    setHighlights(transcriptResp.data.highlights ?? []);
  };

  const list = (data?.recordings ?? []).filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (r.lead_name ?? '').toLowerCase().includes(q) || (r.phone ?? '').toLowerCase().includes(q);
  });

  const selected = list.find(r => r.id === selectedId);

  return (
    <div className="grid grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_320px] h-[calc(100vh-48px)]">
      {/* List */}
      <aside className="flex flex-col border-r border-line bg-bg-1 min-w-0">
        <div className="p-2 border-b border-line">
          <Input
            placeholder="Поиск записей…"
            leftSlot={<Search size={13} />}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading
            ? <div className="p-2 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
            : list.length === 0
              ? <EmptyState icon={<Mic size={22} />} title="Записей пока нет" className="h-full" />
              : list.map(r => (
                  <button
                    key={r.id}
                    onClick={() => void selectRecording(r)}
                    className={`w-full text-left p-3 border-b border-line transition-colors ${r.id === selectedId ? 'bg-bg-2' : 'hover:bg-bg-2/60'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[13px] text-fg-0 truncate">{r.lead_name ?? r.phone ?? '—'}</div>
                      {r.quality_score != null && (
                        <Badge tone={r.quality_score >= 0.7 ? 'ok' : r.quality_score >= 0.4 ? 'warn' : 'danger'} size="sm">
                          {Math.round(r.quality_score * 100)}%
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 num text-[11px] text-fg-2">
                      <Clock size={10} />
                      <span>{fmt(r.duration_seconds)}</span>
                      <span>·</span>
                      <span>{new Date(r.created_at).toLocaleDateString('ru-RU')}</span>
                    </div>
                  </button>
                ))
          }
        </div>
      </aside>

      {/* Center: player + transcript */}
      <section className="flex flex-col bg-bg-0 min-w-0">
        {selected ? (
          <>
            <div className="p-4 border-b border-line">
              {audioUrl
                ? <AudioPlayer url={audioUrl} duration={selected.duration_seconds} />
                : <div className="h-16 grid place-items-center text-fg-2 text-[12px]">Загрузка аудио…</div>}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {transcript
                ? <pre className="text-[13px] text-fg-1 whitespace-pre-wrap font-sans leading-relaxed">{transcript}</pre>
                : <Skeleton className="h-32 w-full" />}
            </div>
          </>
        ) : (
          <EmptyState title="Выбери запись" description="Слева — список звонков." className="h-full" />
        )}
      </section>

      {/* Right: meta */}
      <aside className="hidden xl:flex border-l border-line bg-bg-1 p-4 overflow-y-auto flex-col gap-3">
        {selected ? (
          <>
            <Card padding="sm">
              <CardHeader title="Метрики" />
              <div className="space-y-2 text-[12px]">
                <div className="flex justify-between"><span className="text-fg-2">Канал</span><span className="text-fg-0 capitalize">{selected.channel}</span></div>
                <div className="flex justify-between"><span className="text-fg-2">Длительность</span><span className="num text-fg-0">{fmt(selected.duration_seconds)}</span></div>
                <div className="flex justify-between"><span className="text-fg-2">Начало</span><span className="num text-fg-0">{new Date(selected.started_at).toLocaleString('ru-RU')}</span></div>
              </div>
            </Card>
            {highlights.length > 0 && (
              <Card padding="sm">
                <CardHeader title="Маркеры" />
                <div className="flex flex-wrap gap-1.5">
                  {highlights.map((h, i) => (
                    <Badge key={i} tone={HIGHLIGHT_TONE[h.type] ?? 'neutral'} size="sm">
                      {fmt(Math.floor(h.time_ms / 1000))} · {h.text}
                    </Badge>
                  ))}
                </div>
              </Card>
            )}
          </>
        ) : (
          <div className="text-fg-2 text-[12px] text-center mt-8">Выберите запись для деталей</div>
        )}
      </aside>
    </div>
  );
}
