import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Settings, Volume2 } from 'lucide-react';
import { Card, CardHeader } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

const AIGUL_PROMPT = `Ты — Айгуль, менеджер по продажам цветочного магазина в Алматы. Говори на русском языке. Твоя задача — помочь клиенту выбрать букет и оформить заказ.

Ассортимент:
- "Нежность" — 25 розовых роз, 15 000 тенге
- "Страсть" — 51 красная роза, 45 000 тенге
- "Весенний день" — тюльпаны и нарциссы, 12 000 тенге
- "Подружка" — ромашки и хризантемы, 8 500 тенге
- "Комплимент" — 7 роз, 4 500 тенге
- "Экзотика" — орхидеи, 28 000 тенге

Дополнения: открытка +500тг, конфеты Рафаэлло +2000тг, мишка +3500тг.
Доставка: по Алматы 1500тг (2 часа), срочная 2500тг (1 час), самовывоз бесплатно.

Этапы разговора: 1) Приветствие, 2) Узнай повод и бюджет, 3) Предложи 2-3 букета, 4) Upsell, 5) Уточни доставку.
При "дорого" — предложи дешевле. Тон дружелюбный. Когда клиент готов — подтверди заказ.`;

interface LogEntry {
  time: string;
  type: 'info' | 'user' | 'agent' | 'error' | 'tool';
  text: string;
}

const LOG_COLOR: Record<LogEntry['type'], string> = {
  info:  'text-fg-2',
  user:  'text-[#60a5fa]',
  agent: 'text-ok',
  error: 'text-danger',
  tool:  'text-warn',
};

export default function VoiceTest() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') ?? '');
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showSettings, setShowSettings] = useState(true);
  const [model, setModel] = useState('gemini-3.1-flash-live-preview');

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playQueueRef = useRef<Float32Array[]>([]);
  const playingRef = useRef(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((type: LogEntry['type'], text: string) => {
    setLogs(prev => [...prev, {
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type,
      text,
    }]);
  }, []);

  useEffect(() => {
    localStorage.setItem('gemini_api_key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const playAudioQueue = useCallback(() => {
    if (playingRef.current || playQueueRef.current.length === 0) return;
    playingRef.current = true;

    const ctx = audioContextRef.current;
    if (!ctx) { playingRef.current = false; return; }

    const chunk = playQueueRef.current.shift()!;
    const buffer = ctx.createBuffer(1, chunk.length, 24000);
    buffer.getChannelData(0).set(chunk);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      playingRef.current = false;
      playAudioQueue();
    };
    source.start();
  }, []);

  const startCapture = useCallback((ctx: AudioContext, stream: MediaStream, ws: WebSocket) => {
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN || muted) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]!));
        pcm16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64 }],
        },
      }));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  }, [muted]);

  const stopCapture = useCallback(() => {
    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();
    processorRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    addLog('info', 'Подключение к Gemini Live (через прокси)…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      addLog('info', 'Микрофон подключён');

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;

      const wsUrl = `ws://127.0.0.1:3003/ws/gemini-live?model=${encodeURIComponent(model)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog('info', 'WebSocket подключён, отправляю setup…');
        ws.send(JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
            },
            systemInstruction: { parts: [{ text: AIGUL_PROMPT }] },
          },
        }));
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(event.data as string); } catch { return; }

        if (msg['setupComplete']) {
          addLog('info', 'Gemini Live готов. Говорите…');
          setConnected(true);
          setShowSettings(false);
          startCapture(ctx, stream, ws);
          return;
        }

        const serverContent = msg['serverContent'] as Record<string, unknown> | undefined;
        if (serverContent) {
          const modelTurn = serverContent['modelTurn'] as Record<string, unknown> | undefined;
          if (modelTurn?.['parts']) {
            const parts = modelTurn['parts'] as Array<Record<string, unknown>>;
            for (const part of parts) {
              if (part['inlineData']) {
                const inlineData = part['inlineData'] as Record<string, string>;
                const base64 = inlineData['data']!;
                const pcmBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                const pcm16 = new Int16Array(pcmBytes.buffer);
                const float32 = new Float32Array(pcm16.length);
                for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i]! / 32768;
                playQueueRef.current.push(float32);
                playAudioQueue();
              }
              if (part['text']) addLog('agent', part['text'] as string);
            }
          }
          if (serverContent['turnComplete']) addLog('info', '— конец реплики —');
        }

        const toolCall = msg['toolCall'] as Record<string, unknown> | undefined;
        if (toolCall?.['functionCalls']) {
          const calls = toolCall['functionCalls'] as Array<Record<string, unknown>>;
          for (const call of calls) addLog('tool', `${call['name']}: ${JSON.stringify(call['args'])}`);
        }
      };

      ws.onerror = (err) => {
        addLog('error', `WebSocket ошибка: ${(err as ErrorEvent).message ?? 'unknown'}`);
      };

      ws.onclose = (ev) => {
        addLog('info', `Соединение закрыто (${ev.code}: ${ev.reason || 'normal'})`);
        setConnected(false);
        stopCapture();
      };

    } catch (err) {
      addLog('error', `Ошибка: ${(err as Error).message}`);
    }
  }, [model, addLog, playAudioQueue, startCapture, stopCapture]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    stopCapture();
    setConnected(false);
    playQueueRef.current = [];
    addLog('info', 'Звонок завершён');
  }, [stopCapture, addLog]);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[15px] font-semibold text-fg-0">Тест голосового звонка</h1>
          <p className="text-[12px] text-fg-2 mt-0.5">Gemini Live — прямое подключение из браузера</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowSettings(s => !s)} iconLeft={<Settings size={13} />}>
          Настройки
        </Button>
      </div>

      {showSettings && (
        <Card>
          <CardHeader title="Настройки" />
          <div className="space-y-3">
            <Input
              label="Google API Key"
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="AIza…"
              hint="Получить на aistudio.google.com/apikey"
              className="font-mono"
            />
            <div className="flex flex-col gap-1 text-[13px]">
              <span className="text-fg-1">Модель</span>
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="h-9 bg-bg-1 border border-line rounded-2 px-3 text-fg-0 outline-none focus:border-accent text-[13px]"
              >
                <option value="gemini-3.1-flash-live-preview">gemini-3.1-flash-live-preview</option>
                <option value="gemini-2.5-flash-native-audio-latest">gemini-2.5-flash-native-audio-latest</option>
                <option value="gemini-2.5-flash-native-audio-preview-12-2025">gemini-2.5-flash-native-audio-preview-12-2025</option>
                <option value="gemini-2.5-flash-native-audio-preview-09-2025">gemini-2.5-flash-native-audio-preview-09-2025</option>
              </select>
            </div>
          </div>
        </Card>
      )}

      <Card className="!bg-bg-1 text-center">
        <div className="mb-5">
          <div className="w-14 h-14 mx-auto rounded-full bg-accent/15 text-accent grid place-items-center text-[18px] font-semibold mb-2">А</div>
          <div className="text-[15px] font-semibold text-fg-0">Айгуль</div>
          <div className="text-[12px] text-fg-2">Менеджер цветочного магазина</div>
          <div className={`num text-[11px] mt-2 uppercase tracking-wider ${connected ? 'text-ok' : 'text-fg-2'}`}>
            {connected ? '● На связи' : '○ Не подключено'}
          </div>
        </div>

        <div className="flex items-center justify-center gap-5">
          <button
            onClick={() => setMuted(m => !m)}
            disabled={!connected}
            aria-label={muted ? 'Включить микрофон' : 'Заглушить'}
            className={`w-12 h-12 rounded-full grid place-items-center transition-colors ${
              !connected ? 'bg-bg-2 text-fg-2' :
              muted ? 'bg-danger text-white' :
              'bg-bg-2 text-fg-0 hover:bg-line'
            }`}
          >
            {muted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>

          {!connected ? (
            <button
              onClick={() => void connect()}
              disabled={!apiKey.trim()}
              aria-label="Позвонить"
              className="w-14 h-14 rounded-full bg-accent hover:brightness-110 disabled:bg-bg-2 disabled:text-fg-2 text-accent-fg grid place-items-center transition-all shadow-d-3"
            >
              <Phone size={22} />
            </button>
          ) : (
            <button
              onClick={disconnect}
              aria-label="Завершить"
              className="w-14 h-14 rounded-full bg-danger hover:brightness-110 text-white grid place-items-center transition-all shadow-d-3"
            >
              <PhoneOff size={22} />
            </button>
          )}

          <div className={`w-12 h-12 rounded-full grid place-items-center ${connected ? 'bg-bg-2 text-fg-0' : 'bg-bg-2 text-fg-2'}`}>
            <Volume2 size={20} />
          </div>
        </div>
      </Card>

      <Card padding="none">
        <div className="px-4 py-3 border-b border-line flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-fg-0">Лог разговора</h3>
          {logs.length > 0 && (
            <button onClick={() => setLogs([])} className="text-[11px] text-fg-2 hover:text-fg-0">
              Очистить
            </button>
          )}
        </div>
        <div className="p-4 max-h-80 overflow-y-auto font-mono text-[11px] space-y-0.5">
          {logs.length === 0
            ? <div className="text-fg-2 text-center py-4">Нажми зелёную кнопку, чтобы начать.</div>
            : logs.map((log, i) => (
                <div key={i} className={LOG_COLOR[log.type]}>
                  <span className="text-fg-2">{log.time}</span>{' '}{log.text}
                </div>
              ))
          }
          <div ref={logsEndRef} />
        </div>
      </Card>
    </div>
  );
}
