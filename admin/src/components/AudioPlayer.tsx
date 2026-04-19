import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Volume2 } from 'lucide-react';

interface Props {
  url:      string;
  duration: number;
}

export default function AudioPlayer({ url, duration }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef        = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady]       = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container:   containerRef.current,
      waveColor:   '#94a3b8',
      progressColor: '#4f6ef7',
      cursorColor:   '#4f6ef7',
      height:      64,
      barWidth:    2,
      barGap:      1,
      barRadius:   2,
    });

    ws.load(url);
    ws.on('ready', () => setReady(true));
    ws.on('timeupdate', (t: number) => setCurrentTime(t));
    ws.on('finish',   () => setPlaying(false));
    wsRef.current = ws;

    return () => { ws.destroy(); };
  }, [url]);

  const toggle = () => {
    if (!wsRef.current || !ready) return;
    wsRef.current.playPause();
    setPlaying(p => !p);
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={!ready}
          className="w-10 h-10 rounded-full bg-brand-500 hover:bg-brand-600 flex items-center justify-center text-white disabled:opacity-40 transition-colors shrink-0"
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>

        <div className="flex-1 min-w-0">
          <div ref={containerRef} />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>{fmt(currentTime)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        <Volume2 size={16} className="text-gray-400 shrink-0" />
      </div>
    </div>
  );
}
