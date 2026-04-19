import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import type { Recording } from '../api';
import AudioPlayer from '../components/AudioPlayer';
import { Mic, Clock } from 'lucide-react';

export default function Recordings() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl]     = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Array<{time_ms:number;type:string;text:string}>>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['recordings'],
    queryFn:  () => api.get('/recordings').then(r => r.data as { recordings: Recording[] }),
  });

  const selectRecording = async (rec: Recording) => {
    setSelectedId(rec.id);
    setAudioUrl(null);
    setTranscript(null);
    const [audioResp, transcriptResp] = await Promise.all([
      api.get(`/recordings/${rec.id}/audio`),
      api.get(`/recordings/${rec.id}/transcript`),
    ]);
    setAudioUrl(audioResp.data.url);
    setTranscript(transcriptResp.data.transcript);
    setHighlights(transcriptResp.data.highlights ?? []);
  };

  const HIGHLIGHT_COLORS: Record<string, string> = {
    objection: 'bg-red-100 text-red-700 border-red-200',
    agreement: 'bg-green-100 text-green-700 border-green-200',
    pricing:   'bg-yellow-100 text-yellow-700 border-yellow-200',
  };

  const fmt = (s: number) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;

  return (
    <div className="flex gap-4 h-[calc(100vh-6rem)]">
      {/* Список записей */}
      <div className="w-80 shrink-0 flex flex-col">
        <h1 className="text-xl font-bold text-gray-900 mb-4">Записи звонков</h1>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-8 text-center text-gray-400">Загрузка...</div>
          ) : data?.recordings.length === 0 ? (
            <div className="p-8 text-center text-gray-400">
              <Mic size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Записей пока нет</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {data?.recordings.map(rec => (
                <button
                  key={rec.id}
                  onClick={() => void selectRecording(rec)}
                  className={`w-full text-left p-4 hover:bg-gray-50 transition-colors ${
                    rec.id === selectedId ? 'bg-brand-50 border-l-2 border-brand-500' : ''
                  }`}
                >
                  <div className="font-medium text-sm text-gray-900">{rec.lead_name ?? rec.phone ?? '—'}</div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
                    <Clock size={11} />
                    <span>{fmt(rec.duration_seconds)}</span>
                    <span>·</span>
                    <span>{new Date(rec.created_at).toLocaleDateString('ru-RU')}</span>
                  </div>
                  {rec.quality_score && (
                    <div className="mt-1">
                      <span className={`text-xs font-medium ${
                        rec.quality_score >= 0.7 ? 'text-green-600' : rec.quality_score >= 0.4 ? 'text-yellow-600' : 'text-red-600'
                      }`}>
                        Качество: {Math.round(rec.quality_score * 100)}%
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Плеер + транскрипт */}
      {selectedId && (
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          {audioUrl && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <h3 className="font-semibold text-gray-900 mb-3">Воспроизведение</h3>
              <AudioPlayer
                url={audioUrl}
                duration={data?.recordings.find(r => r.id === selectedId)?.duration_seconds ?? 0}
              />
            </div>
          )}

          {highlights.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <h3 className="font-semibold text-gray-900 mb-3">Маркеры</h3>
              <div className="flex flex-wrap gap-2">
                {highlights.map((h, i) => (
                  <span key={i} className={`px-2 py-1 rounded-lg text-xs border ${HIGHLIGHT_COLORS[h.type] ?? 'bg-gray-100'}`}>
                    {fmt(Math.floor(h.time_ms/1000))} · {h.text}
                  </span>
                ))}
              </div>
            </div>
          )}

          {transcript && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm flex-1 overflow-y-auto">
              <h3 className="font-semibold text-gray-900 mb-3">Транскрипт</h3>
              <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
                {transcript}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
