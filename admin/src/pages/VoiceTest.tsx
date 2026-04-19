import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Settings, Volume2 } from 'lucide-react';

/**
 * Страница тестирования голосовых звонков.
 * Подключается к Gemini Live API напрямую из браузера через WebSocket.
 * Не нужен Voximplant, публичный сервер или наш бэкенд.
 *
 * Требуется: Google API Key с доступом к Gemini Live.
 */

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

  // Автоскролл логов
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Воспроизвести очередь аудио
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
      playAudioQueue(); // Играем следующий чанк
    };
    source.start();
  }, []);

  // Подключиться к Gemini Live (через наш бэкенд-прокси)
  const connect = useCallback(async () => {
    addLog('info', 'Подключение к Gemini Live (через прокси)...');

    try {
      // 1. Получаем микрофон
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      addLog('info', 'Микрофон подключён');

      // 2. AudioContext
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;

      // 3. WebSocket к нашему прокси (он уже знает GOOGLE_API_KEY)
      const wsUrl = `ws://127.0.0.1:3002/ws/gemini-live?model=${encodeURIComponent(model)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog('info', 'WebSocket подключён, отправляю setup...');

        // Setup message
        ws.send(JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Aoede' },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: AIGUL_PROMPT }],
            },
          },
        }));
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // Setup complete
        if (msg['setupComplete']) {
          addLog('info', '✅ Gemini Live готов! Говорите...');
          setConnected(true);
          setShowSettings(false);
          startCapture(ctx, stream, ws);
          return;
        }

        // Server content (audio/text response)
        const serverContent = msg['serverContent'] as Record<string, unknown> | undefined;
        if (serverContent) {
          const modelTurn = serverContent['modelTurn'] as Record<string, unknown> | undefined;
          if (modelTurn?.['parts']) {
            const parts = modelTurn['parts'] as Array<Record<string, unknown>>;
            for (const part of parts) {
              // Аудио ответ
              if (part['inlineData']) {
                const inlineData = part['inlineData'] as Record<string, string>;
                const base64 = inlineData['data']!;
                const pcmBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                const pcm16 = new Int16Array(pcmBytes.buffer);

                // Конвертируем Int16 → Float32 для Web Audio
                const float32 = new Float32Array(pcm16.length);
                for (let i = 0; i < pcm16.length; i++) {
                  float32[i] = pcm16[i]! / 32768;
                }
                playQueueRef.current.push(float32);
                playAudioQueue();
              }

              // Текстовый транскрипт
              if (part['text']) {
                addLog('agent', part['text'] as string);
              }
            }
          }

          // Конец реплики
          if (serverContent['turnComplete']) {
            addLog('info', '— конец реплики —');
          }
        }

        // Tool call
        const toolCall = msg['toolCall'] as Record<string, unknown> | undefined;
        if (toolCall?.['functionCalls']) {
          const calls = toolCall['functionCalls'] as Array<Record<string, unknown>>;
          for (const call of calls) {
            addLog('tool', `🔧 ${call['name']}: ${JSON.stringify(call['args'])}`);
          }
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
  }, [apiKey, model, addLog, playAudioQueue]);

  // Захват аудио с микрофона и отправка в Gemini
  const startCapture = useCallback((ctx: AudioContext, stream: MediaStream, ws: WebSocket) => {
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode для получения PCM-данных
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN || muted) return;

      const input = e.inputBuffer.getChannelData(0);
      // Float32 → Int16
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]!));
        pcm16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));

      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{
            mimeType: 'audio/pcm;rate=16000',
            data: base64,
          }],
        },
      }));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  }, [muted]);

  // Остановить захват
  const stopCapture = useCallback(() => {
    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();
    processorRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
  }, []);

  // Отключиться
  const disconnect = useCallback(() => {
    wsRef.current?.close();
    stopCapture();
    setConnected(false);
    playQueueRef.current = [];
    addLog('info', 'Звонок завершён');
  }, [stopCapture, addLog]);

  const LOG_COLORS: Record<string, string> = {
    info:  'text-gray-400',
    user:  'text-blue-400',
    agent: 'text-green-400',
    error: 'text-red-400',
    tool:  'text-orange-400',
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Тест голосового звонка</h1>
          <p className="text-sm text-gray-500 mt-0.5">Gemini Live — прямое подключение из браузера</p>
        </div>
        <button
          onClick={() => setShowSettings(s => !s)}
          className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <Settings size={20} />
        </button>
      </div>

      {/* Настройки */}
      {showSettings && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4">
          <h3 className="font-semibold text-gray-900">Настройки</h3>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Google API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="AIza..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
            />
            <p className="text-xs text-gray-400 mt-1">
              Получить на <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-brand-500 underline">aistudio.google.com/apikey</a>
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Модель</label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="gemini-3.1-flash-live-preview">gemini-3.1-flash-live-preview ⭐</option>
              <option value="gemini-2.5-flash-native-audio-latest">gemini-2.5-flash-native-audio-latest</option>
              <option value="gemini-2.5-flash-native-audio-preview-12-2025">gemini-2.5-flash-native-audio-preview-12-2025</option>
              <option value="gemini-2.5-flash-native-audio-preview-09-2025">gemini-2.5-flash-native-audio-preview-09-2025</option>
            </select>
          </div>
        </div>
      )}

      {/* Панель звонка */}
      <div className="bg-gray-900 rounded-2xl p-8 text-white text-center shadow-lg">
        <div className="mb-6">
          <div className="text-5xl mb-3">🌸</div>
          <div className="text-lg font-semibold">Айгуль</div>
          <div className="text-sm text-gray-400">Менеджер цветочного магазина</div>
          <div className={`text-xs mt-2 ${connected ? 'text-green-400' : 'text-gray-500'}`}>
            {connected ? '● На связи — говорите' : '○ Не подключено'}
          </div>
        </div>

        <div className="flex items-center justify-center gap-6">
          {/* Мут */}
          <button
            onClick={() => setMuted(m => !m)}
            disabled={!connected}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              !connected ? 'bg-gray-700 text-gray-500' :
              muted ? 'bg-red-500 hover:bg-red-600 text-white' :
              'bg-gray-700 hover:bg-gray-600 text-white'
            }`}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          {/* Звонок / Повесить */}
          {!connected ? (
            <button
              onClick={() => void connect()}
              disabled={!apiKey.trim()}
              className="w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500 text-white flex items-center justify-center transition-colors shadow-lg shadow-green-500/30"
            >
              <Phone size={26} />
            </button>
          ) : (
            <button
              onClick={disconnect}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-colors shadow-lg shadow-red-500/30"
            >
              <PhoneOff size={26} />
            </button>
          )}

          {/* Динамик */}
          <div className={`w-14 h-14 rounded-full flex items-center justify-center ${
            connected ? 'bg-gray-700 text-white' : 'bg-gray-700 text-gray-500'
          }`}>
            <Volume2 size={22} />
          </div>
        </div>
      </div>

      {/* Лог разговора */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h3 className="font-medium text-gray-300 text-sm">Лог разговора</h3>
          {logs.length > 0 && (
            <button onClick={() => setLogs([])} className="text-xs text-gray-500 hover:text-gray-300">
              Очистить
            </button>
          )}
        </div>
        <div className="p-4 max-h-80 overflow-y-auto font-mono text-xs space-y-1">
          {logs.length === 0 ? (
            <div className="text-gray-600 text-center py-4">
              Нажмите кнопку звонка чтобы начать
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className={LOG_COLORS[log.type]}>
                <span className="text-gray-600">{log.time}</span>{' '}
                {log.text}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Инструкция */}
      <div className="bg-blue-50 rounded-xl border border-blue-200 p-4 text-sm text-blue-800">
        <p className="font-medium mb-2">Как использовать:</p>
        <ol className="list-decimal ml-4 space-y-1">
          <li>Получите Google API Key на <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline">aistudio.google.com</a></li>
          <li>Вставьте ключ в поле выше</li>
          <li>Нажмите зелёную кнопку — разрешите доступ к микрофону</li>
          <li>Говорите на русском — Айгуль ответит голосом</li>
          <li>Красная кнопка — завершить звонок</li>
        </ol>
        <p className="mt-2 text-xs text-blue-600">
          Звонок идёт напрямую из браузера в Gemini Live API. Не нужен Voximplant или публичный сервер.
        </p>
      </div>
    </div>
  );
}
