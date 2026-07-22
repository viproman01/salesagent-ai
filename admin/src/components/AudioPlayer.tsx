import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause } from 'lucide-react';

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
  const [rate,  setRate]        = useState(1);

  useEffect(() => {
    if (!containerRef.current) return;
    const root = getComputedStyle(document.documentElement);
    const fg2 = root.getPropertyValue('--fg-2').trim() || '#6b7280';
    const accent = root.getPropertyValue('--accent').trim() || '#00b14f';

    const ws = WaveSurfer.create({
      container:   containerRef.current,
      waveColor:   fg2,
      progressColor: accent,
      cursorColor:   accent,
      height:      56,
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

  useEffect(() => {
    wsRef.current?.setPlaybackRate(rate);
  }, [rate]);

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
    <div className="bg-bg-1 rounded-2 p-3 border border-line">
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={!ready}
          className="w-9 h-9 rounded-full bg-accent hover:brightness-110 active:brightness-95 flex items-center justify-center text-accent-fg disabled:opacity-40 transition-all shrink-0"
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>

        <div className="flex-1 min-w-0">
          <div ref={containerRef} />
          <div className="flex justify-between num text-[10px] text-fg-2 mt-1">
            <span>{fmt(currentTime)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        <select
          value={rate}
          onChange={e => setRate(Number(e.target.value))}
          className="num bg-bg-2 border border-line rounded-1 h-7 text-[11px] px-1 text-fg-0 outline-none"
          aria-label="Скорость"
        >
          <option value={0.75}>0.75×</option>
          <option value={1}>1×</option>
          <option value={1.25}>1.25×</option>
          <option value={1.5}>1.5×</option>
          <option value={2}>2×</option>
        </select>
      </div>
    </div>
  );
}
