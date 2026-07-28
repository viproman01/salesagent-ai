import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, Bot, BrainCircuit, Clock3, Gauge, Headphones, Languages, Mic,
  MicOff, Phone, PhoneOff, Play, Radio, Settings2, ShieldCheck, Sparkles,
  RefreshCw, UserRoundPlus, Volume2, X,
} from 'lucide-react';
import api, { type Agent } from '../api';

type Provider = 'openrouter' | 'cerebras';
type TtsProvider = 'cartesia' | 'fish';
type CallState = 'idle' | 'starting' | 'ready' | 'listening' | 'processing' | 'playing' | 'muted' | 'error';
type Turn = {
  role: 'user' | 'assistant';
  text: string;
  source?: 'fast' | 'deep';
  diagnostics?: {
    sttModel: string;
    llmModel: string;
    sttMs: number;
    llmMs: number;
    ttsMs: number;
    firstAudioMs?: number;
    costUsd: number;
    fallbackUsed: boolean;
  };
};
interface ModelOption { id: string; name: string; recommended: boolean }
interface VoiceOption {
  id: string;
  name: string;
  languages?: string[];
  language?: string;
  gender?: 'masculine' | 'feminine' | 'gender_neutral' | null;
}
interface SttOption { id: string; name: string; recommended: boolean; price?: string }
interface ProviderStatus {
  openrouter: boolean;
  openrouterStt: boolean;
  cerebras: boolean;
  fishAudio: boolean;
  cartesia: boolean;
  cartesiaModel?: string;
}
interface VoiceSessionResponse {
  sessionId: string;
  effective: {
    stt: { provider: 'openrouter'; model: string; language: string };
    llm: {
      model: string;
      fastModel?: string;
      deepModel?: string;
      mode?: 'fast-with-background-deep';
    };
    tts: { provider: TtsProvider; model: string; voiceId: string | null; speed: number };
  };
  limits: { maxUtteranceSeconds: number; maxUploadMb: number };
}
interface UtteranceResponse {
  transcript: string;
  text: string;
  audioUrl: string | null;
  fallbackToText: boolean;
  effective: {
    stt: { provider: 'openrouter'; model: string; fallbackUsed: boolean };
    llm: { model: string; fastModel?: string; deepModel?: string };
    tts: { provider: TtsProvider; model: string; voiceId: string | null };
  };
  latency: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number };
  usage: { audioSeconds: number; sttCostUsd: number; llmTokensInput: number; llmTokensOutput: number };
  background?: {
    triggered: boolean;
    taskId: string | null;
    status: BackgroundState['status'];
    model: string;
    complexity: { complex: boolean; score: number; reasons: string[] };
  };
}
interface BackgroundState {
  status: 'idle' | 'processing' | 'ready' | 'delivering' | 'delivered' | 'superseded' | 'dismissed' | 'failed';
  taskId: string | null;
  question: string | null;
  model: string;
  relevant?: boolean;
  laterTurns?: number;
  completedAt?: string | null;
  error?: string | null;
}
interface BackgroundDelivery {
  taskId: string;
  question: string;
  text: string;
  audioUrl: string | null;
  fallbackToText: boolean;
  effective: { fastModel: string; deepModel: string; ttsProvider: TtsProvider; ttsModel: string };
}
type AudioElementWithSink = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
type MediaDevicesWithOutput = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

const INPUT_STORAGE_KEY = 'salesagent-audio-input';
const OUTPUT_STORAGE_KEY = 'salesagent-audio-output';
const CARTESIA_MOMMY_VOICE_ID = '779673f3-895f-4935-b6b5-b031dc78b319';
const FISH_MOMMY_VOICE_ID = '3cea70d91116442f8086820844db233c';
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

function parseModelRef(ref: string): { provider: Provider; model: string } {
  if (ref.startsWith('cerebras/') && ref.length > 'cerebras/'.length) {
    return { provider: 'cerebras', model: ref.slice('cerebras/'.length) };
  }
  return { provider: 'openrouter', model: ref };
}

function formatModelRef(provider: Provider, model: string): string {
  return provider === 'cerebras' ? `cerebras/${model}` : model;
}

function requestErrorMessage(error: unknown, fallback: string): string {
  const value = error as {
    response?: { data?: { error?: string; message?: string } };
    message?: string;
  };
  return value.response?.data?.error ?? value.response?.data?.message ?? value.message ?? fallback;
}

function createToneBlob(): Blob {
  const sampleRate = 44_100;
  const seconds = 0.35;
  const samples = Math.floor(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) {
    const envelope = Math.min(1, index / 600) * Math.min(1, (samples - index) / 1200);
    view.setInt16(44 + index * 2, Math.sin(2 * Math.PI * 660 * index / sampleRate) * 0x2fff * envelope, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export default function VoiceTest() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [creatingStarter, setCreatingStarter] = useState(false);
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [model, setModel] = useState('deepseek/deepseek-v4-flash');
  const [openrouterModels, setOpenrouterModels] = useState<ModelOption[]>([]);
  const [cerebrasModels, setCerebrasModels] = useState<ModelOption[]>([]);
  const [sttModels, setSttModels] = useState<SttOption[]>([]);
  const [sttModel, setSttModel] = useState('deepgram/nova-3');
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>('cartesia');
  const [voiceId, setVoiceId] = useState('');
  const [fishVoices, setFishVoices] = useState<VoiceOption[]>([]);
  const [cartesiaVoices, setCartesiaVoices] = useState<VoiceOption[]>([]);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(() => localStorage.getItem(INPUT_STORAGE_KEY) ?? '');
  const [outputId, setOutputId] = useState(() => localStorage.getItem(OUTPUT_STORAGE_KEY) ?? '');
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [level, setLevel] = useState(0);
  const [session, setSession] = useState<VoiceSessionResponse | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [callSeconds, setCallSeconds] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState('');
  const [micMuted, setMicMuted] = useState(false);
  const [effective, setEffective] = useState<VoiceSessionResponse['effective'] | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [background, setBackground] = useState<BackgroundState>({
    status: 'idle',
    taskId: null,
    question: null,
    model: 'deepseek/deepseek-v4-pro',
  });

  const audioRef = useRef<AudioElementWithSink | null>(null);
  const playbackDoneRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<VoiceSessionResponse | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const discardRecordingRef = useRef(false);
  const callActiveRef = useRef(false);
  const micMutedRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const playbackInProgressRef = useRef(false);
  const pauseForBackgroundRef = useRef(false);
  const backgroundDeliveryRef = useRef(false);
  const callStateRef = useRef<CallState>('idle');
  const startRecordingRef = useRef<(activeSession?: VoiceSessionResponse | null) => Promise<void>>(async () => undefined);
  const deliverBackgroundRef = useRef<(taskId: string, force?: boolean) => Promise<void>>(async () => undefined);
  const vadRef = useRef({
    speechSeen: false,
    lastVoiceAt: 0,
    noiseFloor: 0.008,
    speechFrames: 0,
  });

  const applyAgentList = useCallback((allAgents: Agent[]) => {
    // Любой активный агент может участвовать в тестовом звонке. Канал voice
    // определяет боевые интеграции, но не должен блокировать лабораторию.
    const list = allAgents.filter(agent => agent.is_active);
    setAgents(list);
    setAgentId(current => {
      if (list.some(agent => agent.id === current)) return current;
      return list.find(agent => agent.name === 'Mommy')?.id ?? list[0]?.id ?? '';
    });
  }, []);

  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const response = await api.get('/agents');
      applyAgentList((response.data as { agents: Agent[] }).agents ?? []);
    } catch {
      setError('Не удалось загрузить агентов.');
    } finally {
      setAgentsLoading(false);
    }
  }, [applyAgentList]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(device => device.kind === 'audioinput');
    const outputs = devices.filter(device => device.kind === 'audiooutput');
    setInputDevices(inputs);
    setOutputDevices(outputs);
    setInputId(current => {
      if (!current || !inputs.some(device => device.deviceId === current)) {
        const fallback = inputs[0]?.deviceId ?? '';
        if (fallback) localStorage.setItem(INPUT_STORAGE_KEY, fallback);
        return fallback;
      }
      return current;
    });
    setOutputId(current => {
      if (current && !outputs.some(device => device.deviceId === current)) {
        localStorage.removeItem(OUTPUT_STORAGE_KEY);
        return '';
      }
      return current;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [agentsResult, statusResult, cerebrasResult, fishResult, cartesiaResult] = await Promise.allSettled([
        api.get('/agents'),
        api.get('/providers/status'),
        api.get('/providers/cerebras/models'),
        api.get('/providers/fish/voices'),
        api.get('/providers/cartesia/voices'),
      ]);
      if (cancelled) return;

      if (agentsResult.status === 'fulfilled') {
        applyAgentList((agentsResult.value.data as { agents: Agent[] }).agents ?? []);
      } else {
        setError('Не удалось загрузить голосовых агентов.');
      }
      setAgentsLoading(false);

      const status = statusResult.status === 'fulfilled'
        ? statusResult.value.data as ProviderStatus
        : null;
      setProviderStatus(status);
      if (cerebrasResult.status === 'fulfilled') {
        setCerebrasModels((cerebrasResult.value.data as { models: ModelOption[] }).models ?? []);
      }
      if (fishResult.status === 'fulfilled') {
        setFishVoices((fishResult.value.data as { voices: VoiceOption[] }).voices ?? []);
      }
      if (cartesiaResult.status === 'fulfilled') {
        setCartesiaVoices((cartesiaResult.value.data as { voices: VoiceOption[] }).voices ?? []);
      }

      // A missing key is a known configuration state, not a failed browser
      // request. Avoid generating two noisy 503 responses in DevTools.
      if (status?.openrouter) {
        const [modelsResult, sttResult] = await Promise.allSettled([
          api.get('/providers/openrouter/models'),
          api.get('/providers/openrouter/stt-models'),
        ]);
        if (cancelled) return;
        if (modelsResult.status === 'fulfilled') {
          setOpenrouterModels((modelsResult.value.data as { models: ModelOption[] }).models ?? []);
        }
        if (sttResult.status === 'fulfilled') {
          const payload = sttResult.value.data as {
            models: SttOption[];
            defaultModel: string;
          };
          setSttModels(payload.models ?? []);
          setSttModel(payload.defaultModel || 'deepgram/nova-3');
        }
      }
    })();
    const mediaDevices = navigator.mediaDevices;
    const onDeviceChange = () => void refreshDevices();
    mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    void refreshDevices();
    return () => {
      cancelled = true;
      callActiveRef.current = false;
      discardRecordingRef.current = true;
      mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      audioRef.current?.pause();
      playbackDoneRef.current?.();
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      void contextRef.current?.close();
    };
  }, [applyAgentList, refreshDevices]);

  useEffect(() => {
    const agent = agents.find(item => item.id === agentId);
    if (!agent) return;
    const selection = parseModelRef(agent.model_text);
    setProvider(selection.provider);
    setModel(selection.model);
    setTtsProvider(agent.voice_config?.provider ?? 'cartesia');
    setVoiceId(agent.voice_config?.voiceId ?? '');
    setSttModel(agent.voice_config?.stt?.model ?? 'deepgram/nova-3');
  }, [agentId, agents]);

  useEffect(() => {
    if (!session) {
      setCallSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const updateDuration = () => setCallSeconds(Math.floor((Date.now() - startedAt) / 1000));
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  useEffect(() => {
    if (!session) {
      setBackground({
        status: 'idle',
        taskId: null,
        question: null,
        model: 'deepseek/deepseek-v4-pro',
      });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await api.get(`/voice/sessions/${session.sessionId}/background`, {
          timeout: 8_000,
        });
        if (cancelled || sessionRef.current?.sessionId !== session.sessionId) return;
        const state = response.data as BackgroundState;
        setBackground(state);
        if (state.status === 'ready' && state.taskId && state.relevant !== false) {
          void deliverBackgroundRef.current(state.taskId);
        }
      } catch {
        // The foreground call must keep working even if a status poll fails.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session]);

  const requestMicPermission = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: inputId ? { deviceId: { exact: inputId } } : true,
      });
      stream.getTracks().forEach(track => track.stop());
      setMicAllowed(true);
      await refreshDevices();
    } catch {
      setMicAllowed(false);
      setError('Доступ к выбранному микрофону отклонён. Разрешите его в настройках браузера.');
    }
  };

  const createStarterAgent = async () => {
    setCreatingStarter(true);
    setError('');
    try {
      const response = await api.post('/agents/starter');
      const starter = response.data as { id: string };
      await refreshAgents();
      setAgentId(starter.id);
    } catch (requestError) {
      setError(requestErrorMessage(requestError, 'Не удалось создать стартового агента.'));
    } finally {
      setCreatingStarter(false);
    }
  };

  const applyOutput = useCallback(async (audio: AudioElementWithSink) => {
    if (outputId && audio.setSinkId) await audio.setSinkId(outputId);
  }, [outputId]);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    playbackDoneRef.current?.();
    playbackDoneRef.current = null;
    audioRef.current = null;
    playbackInProgressRef.current = false;
  }, []);

  const playAudio = useCallback(async (url: string, manageCallState = true): Promise<number> => {
    stopPlayback();
    const audio = new Audio(url) as AudioElementWithSink;
    const requestedAt = performance.now();
    let firstAudioMs = 0;
    await applyOutput(audio);
    audioRef.current = audio;
    playbackInProgressRef.current = manageCallState;
    if (manageCallState && !micMutedRef.current) setCallState('playing');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (playbackError?: Error) => {
        if (settled) return;
        settled = true;
        if (audioRef.current === audio) audioRef.current = null;
        playbackDoneRef.current = null;
        playbackInProgressRef.current = false;
        audio.onended = null;
        audio.onerror = null;
        if (playbackError) reject(playbackError);
        else resolve();
      };
      playbackDoneRef.current = () => finish();
      audio.onplaying = () => {
        if (!firstAudioMs) firstAudioMs = Math.round(performance.now() - requestedAt);
      };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('Audio playback failed'));
      void audio.play().catch(playbackError => finish(
        playbackError instanceof Error ? playbackError : new Error('Audio playback failed')
      ));
    });
    return firstAudioMs;
  }, [applyOutput, stopPlayback]);

  const chooseOutput = async () => {
    const mediaDevices = navigator.mediaDevices as MediaDevicesWithOutput;
    if (!mediaDevices.selectAudioOutput) {
      setError('Этот браузер не поддерживает системный выбор аудиовыхода. Используется доступный список или устройство по умолчанию.');
      return;
    }
    try {
      const selected = await mediaDevices.selectAudioOutput(outputId ? { deviceId: outputId } : undefined);
      setOutputDevices(current => current.some(item => item.deviceId === selected.deviceId)
        ? current
        : [...current, selected]);
      setOutputId(selected.deviceId);
      localStorage.setItem(OUTPUT_STORAGE_KEY, selected.deviceId);
    } catch {
      setError('Выбор аудиовыхода отменён.');
    }
  };

  const testOutput = async () => {
    const url = URL.createObjectURL(createToneBlob());
    try {
      await playAudio(url, false);
    } catch {
      setError('Браузер не смог воспроизвести тестовый звук на выбранном устройстве.');
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  };

  const cleanupCapture = useCallback((releaseHardware = false) => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    setLevel(0);
    if (releaseHardware) {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      void contextRef.current?.close();
      contextRef.current = null;
    }
  }, []);

  const sendAudio = useCallback(async (
    blob: Blob,
    durationMs: number,
    activeSession: VoiceSessionResponse | null = sessionRef.current
  ) => {
    if (!activeSession || !callActiveRef.current) return;
    turnInFlightRef.current = true;
    setCallState('processing');
    setError('');
    const form = new FormData();
    const extension = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    form.append('audio', blob, `utterance.${extension}`);
    form.append('clientUtteranceId', crypto.randomUUID());
    form.append('durationMs', String(Math.max(100, Math.round(durationMs))));
    try {
      const response = await api.post(`/voice/sessions/${activeSession.sessionId}/utterances`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 90_000,
      });
      const data = response.data as UtteranceResponse;
      if (!callActiveRef.current || sessionRef.current?.sessionId !== activeSession.sessionId) return;
      setTurns(current => [
        ...current,
        { role: 'user', text: data.transcript },
        {
          role: 'assistant',
          text: data.text,
          source: 'fast',
          diagnostics: {
            sttModel: data.effective.stt.model,
            llmModel: data.effective.llm.model,
            sttMs: data.latency.sttMs,
            llmMs: data.latency.llmMs,
            ttsMs: data.latency.ttsMs,
            costUsd: data.usage.sttCostUsd,
            fallbackUsed: data.effective.stt.fallbackUsed,
          },
        },
      ]);
      setEffective(current => current ? {
        ...current,
        stt: { ...current.stt, model: data.effective.stt.model },
        llm: {
          model: data.effective.llm.model,
          fastModel: data.effective.llm.fastModel,
          deepModel: data.effective.llm.deepModel,
          mode: 'fast-with-background-deep',
        },
      } : current);
      if (data.background) {
        setBackground(current => ({
          status: data.background!.status,
          taskId: data.background!.taskId,
          question: data.background!.triggered ? data.transcript : current.question,
          model: data.background!.model,
        }));
      }
      if (data.audioUrl) {
        try {
          const firstAudioMs = await playAudio(data.audioUrl);
          setTurns(current => {
            const copy = [...current];
            for (let index = copy.length - 1; index >= 0; index--) {
              const turn = copy[index];
              if (turn?.role === 'assistant' && turn.source === 'fast' && turn.diagnostics) {
                copy[index] = {
                  ...turn,
                  diagnostics: { ...turn.diagnostics, firstAudioMs },
                };
                break;
              }
            }
            return copy;
          });
        } catch {
          setError('Ответ получен, но браузер не смог воспроизвести аудио. Текст ответа показан ниже.');
        }
      } else {
        setError('Ответ получен текстом: TTS-провайдер не вернул звуковой поток.');
      }
    } catch (requestError) {
      if (callActiveRef.current && sessionRef.current?.sessionId === activeSession.sessionId) {
        setCallState('error');
        setError(requestErrorMessage(requestError, 'Не удалось обработать голосовую реплику.'));
      }
    } finally {
      turnInFlightRef.current = false;
      if (callActiveRef.current && sessionRef.current?.sessionId === activeSession.sessionId) {
        if (micMutedRef.current) {
          setCallState('muted');
        } else {
          setCallState('ready');
          void startRecordingRef.current(activeSession);
        }
      }
    }
  }, [playAudio]);

  const stopRecording = useCallback((discard = false) => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive' || stopRequestedRef.current) return;
    discardRecordingRef.current = discard;
    stopRequestedRef.current = true;
    recorderRef.current.stop();
  }, []);

  const startRecording = async (
    activeSession: VoiceSessionResponse | null = sessionRef.current
  ) => {
    if (
      !activeSession
      || !callActiveRef.current
      || sessionRef.current?.sessionId !== activeSession.sessionId
      || micMutedRef.current
      || turnInFlightRef.current
      || playbackInProgressRef.current
      || (recorderRef.current && recorderRef.current.state !== 'inactive')
    ) return;
    stopRequestedRef.current = false;
    discardRecordingRef.current = false;
    vadRef.current = {
      speechSeen: false,
      lastVoiceAt: Date.now(),
      noiseFloor: 0.008,
      speechFrames: 0,
    };
    try {
      let stream = streamRef.current;
      const liveTrack = stream?.getAudioTracks().find(track => track.readyState === 'live');
      if (!stream || !liveTrack) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(inputId ? { deviceId: { exact: inputId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        streamRef.current = stream;
      }
      if (
        !callActiveRef.current
        || micMutedRef.current
        || sessionRef.current?.sessionId !== activeSession.sessionId
      ) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      setMicAllowed(true);
      const mimeType = MIME_CANDIDATES.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const shouldDiscard = discardRecordingRef.current
          || !callActiveRef.current
          || micMutedRef.current
          || sessionRef.current?.sessionId !== activeSession.sessionId;
        discardRecordingRef.current = false;
        const durationMs = Date.now() - startedAtRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        cleanupCapture(false);
        recorderRef.current = null;
        if (shouldDiscard) {
          if (callActiveRef.current && sessionRef.current?.sessionId === activeSession.sessionId) {
            if (pauseForBackgroundRef.current) setCallState('ready');
            else if (micMutedRef.current) setCallState('muted');
            else {
              setCallState('ready');
              void startRecordingRef.current(activeSession);
            }
          }
        } else if (blob.size > 0) void sendAudio(blob, durationMs, activeSession);
        else {
          setCallState('error');
          setError('Микрофон не записал аудио. Проверьте выбранное устройство.');
        }
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start(100);
      setCallState('listening');

      let context = contextRef.current;
      if (!context || context.state === 'closed') {
        context = new AudioContext({ latencyHint: 'interactive' });
        contextRef.current = context;
      }
      if (context.state === 'suspended') await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const source = context.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      source.connect(analyser);
      const values = new Uint8Array(analyser.fftSize);
      const silenceMs = agents.find(item => item.id === agentId)?.voice_config?.vad?.silenceMs ?? 480;
      const maxMs = (agents.find(item => item.id === agentId)?.voice_config?.vad?.maxUtteranceSeconds ?? 30) * 1000;
      const updateMeter = () => {
        analyser.getByteTimeDomainData(values);
        let sum = 0;
        for (const value of values) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / values.length);
        setLevel(Math.min(1, rms * 6));
        const now = Date.now();
        const elapsed = now - startedAtRef.current;
        if (elapsed < 350) {
          vadRef.current.noiseFloor = vadRef.current.noiseFloor * 0.75 + rms * 0.25;
        }
        const speechThreshold = Math.max(0.015, vadRef.current.noiseFloor * 2.4);
        if (rms > speechThreshold) {
          vadRef.current.speechFrames += 1;
        } else {
          vadRef.current.speechFrames = Math.max(0, vadRef.current.speechFrames - 1);
        }
        if (vadRef.current.speechFrames >= 3) {
          vadRef.current.speechSeen = true;
          vadRef.current.lastVoiceAt = now;
        }
        if (
          (vadRef.current.speechSeen && now - vadRef.current.lastVoiceAt >= silenceMs)
          || now - startedAtRef.current >= maxMs
        ) {
          stopRecording(!vadRef.current.speechSeen);
          return;
        }
        if (!vadRef.current.speechSeen && elapsed >= 8_000) {
          stopRecording(true);
          return;
        }
        animationRef.current = requestAnimationFrame(updateMeter);
      };
      updateMeter();
    } catch {
      cleanupCapture(true);
      setMicAllowed(false);
      if (callActiveRef.current) {
        setCallState('error');
        setError('Не удалось открыть выбранный микрофон.');
      }
    }
  };
  startRecordingRef.current = startRecording;

  const deliverBackground = async (taskId: string, force = false) => {
    const activeSession = sessionRef.current;
    if (
      !activeSession
      || !callActiveRef.current
      || micMutedRef.current
      || backgroundDeliveryRef.current
      || turnInFlightRef.current
      || playbackInProgressRef.current
      || callStateRef.current !== 'listening'
      || (!force && vadRef.current.speechSeen)
      || !recorderRef.current
    ) return;

    backgroundDeliveryRef.current = true;
    pauseForBackgroundRef.current = true;
    setBackground(current => ({ ...current, status: 'delivering' }));
    setCallState('processing');
    stopRecording(true);

    try {
      for (let attempt = 0; attempt < 20 && recorderRef.current; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 25));
      }
      if (!callActiveRef.current || sessionRef.current?.sessionId !== activeSession.sessionId) return;
      const response = await api.post(
        `/voice/sessions/${activeSession.sessionId}/background/${taskId}/deliver`,
        { force },
        { timeout: 90_000 }
      );
      const data = response.data as BackgroundDelivery;
      if (!callActiveRef.current || sessionRef.current?.sessionId !== activeSession.sessionId) return;
      setTurns(current => [
        ...current,
        { role: 'assistant', text: data.text, source: 'deep' },
      ]);
      setBackground({
        status: 'delivered',
        taskId: data.taskId,
        question: data.question,
        model: data.effective.deepModel,
      });
      if (data.audioUrl) {
        try {
          await playAudio(data.audioUrl);
        } catch {
          setError('Глубокий ответ готов, но браузер не смог воспроизвести аудио. Текст показан ниже.');
        }
      }
    } catch (requestError) {
      const status = (requestError as { response?: { status?: number } }).response?.status;
      if (status !== 409) {
        setError(requestErrorMessage(requestError, 'Не удалось получить готовый глубокий ответ.'));
      }
    } finally {
      pauseForBackgroundRef.current = false;
      backgroundDeliveryRef.current = false;
      if (callActiveRef.current && sessionRef.current?.sessionId === activeSession.sessionId) {
        if (micMutedRef.current) setCallState('muted');
        else {
          setCallState('ready');
          void startRecordingRef.current(activeSession);
        }
      }
    }
  };
  deliverBackgroundRef.current = deliverBackground;

  const startCall = async () => {
    if (!agentId) {
      setError('Сначала выберите агента или создайте стартового Mommy.');
      return;
    }
    if (providerStatus?.openrouterStt === false) {
      setCallState('error');
      setError('Для звонка не настроен OPENROUTER_API_KEY. Добавьте ключ в Pterodactyl и перезапустите сервер.');
      return;
    }
    setCallState('starting');
    setError('');
    setTurns([]);
    try {
      const response = await api.post('/voice/sessions', {
        agentId,
        overrides: {
          modelRef: formatModelRef(provider, model),
          ttsProvider,
          ...(voiceId ? { voiceId } : {}),
        },
      });
      const created = response.data as VoiceSessionResponse;
      callActiveRef.current = true;
      micMutedRef.current = false;
      setMicMuted(false);
      sessionRef.current = created;
      setSession(created);
      setEffective(created.effective);
      setBackground({
        status: 'idle',
        taskId: null,
        question: null,
        model: created.effective.llm.deepModel ?? 'deepseek/deepseek-v4-pro',
      });
      setSttModel(created.effective.stt.model);
      setCallState('ready');
      await startRecording(created);
    } catch (requestError) {
      setCallState('error');
      setError(requestErrorMessage(requestError, 'Не удалось создать голосовую сессию.'));
    }
  };

  const endCall = async () => {
    callActiveRef.current = false;
    turnInFlightRef.current = false;
    pauseForBackgroundRef.current = false;
    backgroundDeliveryRef.current = false;
    stopRecording(true);
    stopPlayback();
    const activeSession = sessionRef.current;
    if (activeSession) {
      await api.delete(`/voice/sessions/${activeSession.sessionId}`).catch(() => undefined);
    }
    cleanupCapture(true);
    sessionRef.current = null;
    setSession(null);
    setEffective(null);
    setError('');
    setCallState('idle');
  };

  const toggleMicrophone = () => {
    const nextMuted = !micMutedRef.current;
    micMutedRef.current = nextMuted;
    setMicMuted(nextMuted);
    if (nextMuted) {
      stopRecording(true);
      setCallState('muted');
      return;
    }
    setCallState('ready');
    void startRecordingRef.current(sessionRef.current);
  };

  const dismissBackground = async () => {
    const activeSession = sessionRef.current;
    if (!activeSession || !background.taskId) return;
    try {
      await api.post(
        `/voice/sessions/${activeSession.sessionId}/background/${background.taskId}/dismiss`
      );
      setBackground(current => ({ ...current, status: 'dismissed' }));
    } catch (requestError) {
      setError(requestErrorMessage(requestError, 'Не удалось скрыть глубокий ответ.'));
    }
  };

  const formattedDuration = `${String(Math.floor(callSeconds / 60)).padStart(2, '0')}:${String(callSeconds % 60).padStart(2, '0')}`;

  const selectedModels = provider === 'cerebras' ? cerebrasModels : openrouterModels;
  const voices = ttsProvider === 'cartesia' ? cartesiaVoices : fishVoices;
  const selectedAgent = agents.find(item => item.id === agentId);
  const latestDiagnostics = [...turns].reverse().find(turn => turn.diagnostics)?.diagnostics;
  const perceivedLatencyMs = latestDiagnostics
    ? latestDiagnostics.sttMs + latestDiagnostics.llmMs + (latestDiagnostics.firstAudioMs ?? 0)
    : 0;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 pb-8">
      <div className="order-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.18em] text-brand-600">
            <Sparkles size={13} /> Real-time voice lab
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Тест голосового звонка</h1>
          <p className="mt-1 text-sm text-gray-500">
            Deepgram STT → быстрая Gemma 4 на Cerebras → потоковый Cartesia Sonic 3.5. Fish Audio остаётся резервом.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${
          callState === 'ready' ? 'bg-green-100 text-green-700'
            : callState === 'error' ? 'bg-red-100 text-red-700'
              : callState === 'idle' ? 'bg-gray-100 text-gray-600'
                : 'bg-blue-100 text-blue-700'
        }`}>
          {callState === 'idle' ? 'Не запущен'
            : callState === 'starting' ? 'Подключаю звонок'
            : callState === 'ready' ? 'Соединено'
              : callState === 'listening' ? 'Слушаю'
                : callState === 'processing' ? 'Распознаю и отвечаю'
                  : callState === 'playing' ? 'Агент говорит'
                    : callState === 'muted' ? 'Микрофон выключен'
                      : 'Ошибка'}
        </span>
      </div>

      {providerStatus?.openrouterStt === false && (
        <div role="alert" className="order-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Распознавание речи отключено.</strong>{' '}
          Сервер не видит <code className="font-mono">OPENROUTER_API_KEY</code>, поэтому Deepgram Nova-3 не может услышать микрофон.
          Добавьте ключ в переменные Pterodactyl или серверный <code className="font-mono">.env</code> и перезапустите сервер.
        </div>
      )}

      {!agentsLoading && agents.length === 0 && (
        <div role="status" className="order-2 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <strong className="flex items-center gap-2">
                <UserRoundPlus size={17} /> Для звонка нужен агент
              </strong>
              <p className="mt-1 text-brand-700">
                Создайте готового Mommy с Gemma 4, DeepSeek и русским голосом Cartesia Sonic 3.5.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void createStarterAgent()}
              disabled={creatingStarter}
              className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {creatingStarter ? 'Создаю…' : 'Создать Mommy'}
            </button>
          </div>
        </div>
      )}

      <div className="order-4 grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm lg:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Bot size={16} /> Агент и модели
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="text-xs font-medium text-gray-600">
              <div className="flex items-center justify-between gap-2">
                <span>Агент для звонка</span>
                <button
                  type="button"
                  onClick={() => void refreshAgents()}
                  disabled={Boolean(session) || agentsLoading}
                  className="flex items-center gap-1 text-[11px] text-brand-600 hover:text-brand-700 disabled:opacity-50"
                >
                  <RefreshCw size={11} className={agentsLoading ? 'animate-spin' : ''} />
                  Обновить
                </button>
              </div>
              <select value={agentId} onChange={event => setAgentId(event.target.value)} disabled={Boolean(session)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="">
                  {agentsLoading ? 'Загружаю агентов…' : agents.length ? 'Выберите агента' : 'Нет доступных агентов'}
                </option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}{agent.channels.includes('voice') ? '' : ' · тестовый звонок'}
                  </option>
                ))}
              </select>
            </div>
            <label className="text-xs font-medium text-gray-600">
              Провайдер LLM
              <select value={provider} onChange={event => {
                const next = event.target.value as Provider;
                setProvider(next);
                setModel(next === 'cerebras' ? 'gemma-4-31b' : 'openrouter/auto');
              }} disabled={Boolean(session)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="openrouter">OpenRouter</option>
                <option value="cerebras">Cerebras</option>
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Быстрая модель LLM
              <input list={`voice-models-${provider}`} value={model} onChange={event => setModel(event.target.value)} disabled={Boolean(session)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm" />
              <datalist id={`voice-models-${provider}`}>
                {selectedModels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </datalist>
            </label>
            <label className="text-xs font-medium text-gray-600">
              STT через OpenRouter
              <select value={sttModel} disabled className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm">
                {(sttModels.length ? sttModels : [{ id: 'deepgram/nova-3', name: 'Deepgram Nova-3', recommended: true }]).map(item => (
                  <option key={item.id} value={item.id}>{item.name}{item.recommended ? ' ★' : ''}</option>
                ))}
              </select>
            </label>
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
              <span className="font-medium">Глубокий фон:</span>{' '}
              <code className="font-mono">deepseek/deepseek-v4-pro</code>
            </div>
            <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
              <label className="text-xs font-medium text-gray-600">
                Провайдер TTS
                <select
                  value={ttsProvider}
                  onChange={event => {
                    const next = event.target.value as TtsProvider;
                    setTtsProvider(next);
                    setVoiceId(next === 'cartesia' ? CARTESIA_MOMMY_VOICE_ID : FISH_MOMMY_VOICE_ID);
                  }}
                  disabled={Boolean(session)}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                >
                  <option value="cartesia" disabled={providerStatus?.cartesia === false}>
                    Cartesia · Sonic 3.5 · streaming
                  </option>
                  <option value="fish" disabled={providerStatus?.fishAudio === false}>
                    Fish Audio · S2.1 Pro Free · fallback
                  </option>
                </select>
              </label>
              <label className="text-xs font-medium text-gray-600">
                {ttsProvider === 'cartesia' ? 'Русский голос Cartesia' : 'Голос Fish Audio'}
                {voices.length ? (
                  <select value={voiceId} onChange={event => setVoiceId(event.target.value)} disabled={Boolean(session)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                    <option value="">Голос провайдера по умолчанию</option>
                    {voiceId && !voices.some(voice => voice.id === voiceId) ? (
                      <option value={voiceId}>Закреплённый голос · {voiceId}</option>
                    ) : null}
                    {voices.map(voice => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name} · {voice.language ?? voice.languages?.join(', ') ?? 'язык не указан'}
                        {voice.gender === 'feminine' ? ' · женский' : voice.gender === 'masculine' ? ' · мужской' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={voiceId} onChange={event => setVoiceId(event.target.value)} disabled={Boolean(session)} placeholder={`${ttsProvider} voice ID`} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm" />
                )}
              </label>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Settings2 size={16} /> Эффективная конфигурация
          </h2>
          <dl className="space-y-3 text-xs">
            <div><dt className="flex items-center gap-1 text-gray-400"><Clock3 size={11} /> STT</dt><dd className="mt-0.5 break-all font-mono text-gray-700">{effective?.stt.model ?? sttModel}</dd></div>
            <div><dt className="text-gray-400">Быстрый LLM</dt><dd className="mt-0.5 break-all font-mono text-gray-700">{effective?.llm.fastModel ?? effective?.llm.model ?? formatModelRef(provider, model)}</dd></div>
            <div><dt className="text-gray-400">Сложные вопросы</dt><dd className="mt-0.5 break-all font-mono text-gray-700">{effective?.llm.deepModel ?? 'deepseek/deepseek-v4-pro'}</dd></div>
            <div>
              <dt className="text-gray-400">TTS</dt>
              <dd className="mt-0.5 break-all font-mono text-gray-700">
                {effective?.tts.provider ?? ttsProvider}/{effective?.tts.model ?? (ttsProvider === 'cartesia' ? 'sonic-3.5' : 's2.1-pro-free')}/{(effective?.tts.voiceId ?? voiceId) || 'default'}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="order-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Headphones size={16} /> Аудиоустройства
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-gray-600">Микрофон</label>
            <select value={inputId} onChange={event => {
              setInputId(event.target.value);
              localStorage.setItem(INPUT_STORAGE_KEY, event.target.value);
            }} disabled={Boolean(session)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
              {!inputDevices.length && <option value="">Разрешите доступ к микрофону</option>}
              {inputDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>)}
            </select>
            <div className="mt-2 flex items-center gap-3">
              <button type="button" onClick={() => void requestMicPermission()} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-700">
                {micAllowed === false ? <MicOff size={14} /> : <Mic size={14} />} Проверить доступ
              </button>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-green-500 transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600">Аудиовыход</label>
            <select value={outputId} onChange={event => {
              setOutputId(event.target.value);
              if (event.target.value) localStorage.setItem(OUTPUT_STORAGE_KEY, event.target.value);
              else localStorage.removeItem(OUTPUT_STORAGE_KEY);
            }} disabled={Boolean(session)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <option value="">Системное устройство по умолчанию</option>
              {outputDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Аудиовыход ${index + 1}`}</option>)}
            </select>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void chooseOutput()} className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-700">Выбрать в браузере</button>
              <button type="button" onClick={() => void testOutput()} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-700"><Volume2 size={14} /> Тест звука</button>
            </div>
          </div>
        </div>
      </section>

      <section className="order-3 overflow-hidden rounded-3xl border border-gray-800 bg-gray-900 text-white shadow-lg">
        <div className="grid lg:grid-cols-[1.15fr_.85fr]">
          <div className="relative border-b border-gray-800 p-6 text-center lg:border-b-0 lg:border-r">
            <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_50%_20%,rgba(79,110,247,.45),transparent_42%)]" />
            <div className="relative">
              <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-gray-700 bg-gray-800/70 px-3 py-1 text-[11px] uppercase tracking-[.18em] text-gray-300">
                <Radio size={12} className={session ? 'text-green-400' : 'text-gray-500'} />
                Voice control
              </div>
              <div className="mt-5 text-2xl font-semibold tracking-tight">
                {selectedAgent?.name ?? 'Голосовой агент'}
              </div>
              <div className="mt-1 text-xs text-gray-400">
                {effective?.tts.voiceId || voiceId
                  ? 'Голос закреплён за сессией'
                  : `Используется голос ${ttsProvider === 'cartesia' ? 'Cartesia' : 'Fish Audio'} по умолчанию`}
              </div>
              {session && <div className="mt-4 font-mono text-3xl font-medium tabular-nums">{formattedDuration}</div>}

              <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
                {session ? (
                  <>
                    <button
                      type="button"
                      onClick={toggleMicrophone}
                      className={`flex h-16 w-16 items-center justify-center rounded-full border transition-[transform,background-color,border-color] duration-150 active:scale-[.96] ${
                        micMuted
                          ? 'border-red-400 bg-red-500 hover:bg-red-600'
                          : 'border-gray-600 bg-gray-700 hover:bg-gray-600'
                      }`}
                      title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                      aria-label={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                    >
                      {micMuted ? <MicOff size={25} /> : <Mic size={25} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void endCall()}
                      className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 transition-[transform,background-color] duration-150 hover:bg-red-600 active:scale-[.96]"
                      title="Завершить звонок"
                      aria-label="Завершить звонок"
                    >
                      <PhoneOff size={25} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startCall()}
                    disabled={!agentId || !model || callState === 'starting' || providerStatus?.openrouterStt === false}
                    className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500 shadow-[0_0_0_10px_rgba(34,197,94,.08)] transition-[transform,background-color] duration-150 hover:bg-green-600 active:scale-[.96] disabled:bg-gray-700 disabled:shadow-none disabled:active:scale-100"
                    title="Принять звонок"
                    aria-label="Принять звонок"
                  >
                    <Phone size={29} />
                  </button>
                )}
              </div>

              <div className="mt-5 min-h-6 text-sm">
                {callState === 'idle' && <p className="text-gray-300">Нажмите зелёную кнопку и говорите без ручной отправки.</p>}
                {callState === 'listening' && <p className="text-green-300">Слушаю — конец реплики определяется автоматически.</p>}
                {callState === 'starting' && <p className="text-blue-300">Открываю микрофон и создаю сессию…</p>}
                {callState === 'ready' && session && <p className="text-gray-300">Соединено. Возвращаюсь к прослушиванию…</p>}
                {callState === 'processing' && <p className="text-blue-300">Deepgram распознаёт, Gemma готовит короткий ответ…</p>}
                {callState === 'playing' && <p className="text-blue-300">{selectedAgent?.name ?? 'Агент'} говорит потоковым голосом…</p>}
                {callState === 'muted' && <p className="text-red-300">Микрофон выключен. Агент вас не слышит.</p>}
              </div>
            </div>
          </div>

          <div className="space-y-5 p-5">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-300">
                  <Gauge size={14} /> Живой конвейер
                </span>
                <span className="font-mono text-xs text-gray-500">
                  {perceivedLatencyMs ? `${perceivedLatencyMs} ms до звука` : 'ожидает звонка'}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  ['STT', latestDiagnostics?.sttMs, 'Deepgram'],
                  ['FAST', latestDiagnostics?.llmMs, 'Gemma 4'],
                  ['AUDIO', latestDiagnostics?.firstAudioMs, effective?.tts.provider === 'fish' ? 'Fish stream' : 'Sonic 3.5'],
                  ['DEEP', undefined, 'DeepSeek'],
                ].map(([label, latency, caption], index) => (
                  <div key={String(label)} className="rounded-xl border border-gray-700 bg-gray-800/70 p-3">
                    <div className={`mb-2 h-1 rounded-full ${
                      index === 3 && background.status === 'processing'
                        ? 'animate-pulse bg-violet-500'
                        : latestDiagnostics && index < 3
                          ? 'bg-green-400'
                          : 'bg-gray-600'
                    }`} />
                    <div className="text-[10px] font-bold tracking-wider text-gray-300">{label}</div>
                    <div className="mt-1 font-mono text-[11px] text-gray-500">
                      {typeof latency === 'number' && latency > 0 ? `${latency}ms` : caption}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-gray-700 bg-gray-800/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <BrainCircuit size={16} className="text-violet-300" />
                    Глубокий контур
                  </div>
                  <p className="mt-1 text-xs leading-5 text-gray-400">
                    DeepSeek не перебивает новую тему. Устаревший результат можно озвучить вручную.
                  </p>
                </div>
                <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                  background.status === 'processing' ? 'animate-pulse bg-violet-500'
                    : background.status === 'ready' ? 'bg-green-400'
                      : background.status === 'failed' ? 'bg-red-500'
                        : 'bg-gray-600'
                }`} />
              </div>

              {session && background.status !== 'idle' && background.status !== 'delivered' && background.status !== 'dismissed' ? (
                <div className="mt-4 rounded-xl border border-gray-700 bg-gray-900/70 p-3">
                  <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-gray-500">
                    <span>
                      {background.status === 'processing' ? 'Анализируется'
                        : background.status === 'ready' && background.relevant !== false ? 'Готов к ближайшей паузе'
                          : background.status === 'ready' ? 'Готов, но тема могла измениться'
                            : background.status === 'delivering' ? 'Начинаю озвучивание'
                              : background.status === 'failed' ? 'Ошибка анализа'
                                : 'Устаревшая задача'}
                    </span>
                    {background.laterTurns ? <span>новых реплик: {background.laterTurns}</span> : null}
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm leading-5 text-gray-300">
                    {background.question ?? 'Ожидается сложный вопрос'}
                  </p>
                  {background.status === 'ready' && background.relevant === false && background.taskId ? (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void deliverBackground(background.taskId!, true)}
                        className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-xs font-medium text-white hover:bg-violet-600"
                      >
                        <Play size={13} /> Озвучить
                      </button>
                      <button
                        type="button"
                        onClick={() => void dismissBackground()}
                        className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-2 text-xs text-gray-300 hover:bg-gray-700"
                      >
                        <X size={13} /> Скрыть
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-gray-700 px-3 py-4 text-xs text-gray-500">
                  <ShieldCheck size={15} /> Сложные вопросы будут показаны здесь с привязкой к реплике.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="order-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="order-7 min-h-48 space-y-3 rounded-xl bg-gray-900 p-4 font-mono text-sm">
        {!turns.length ? <p className="py-8 text-center text-gray-500">Примите звонок и начните говорить — реплики отправляются автоматически.</p> : turns.map((turn, index) => (
          <div key={`${turn.role}-${index}`} className={turn.role === 'user' ? 'text-blue-300' : 'text-green-300'}>
            <p>
              <span className="text-gray-500">
                {turn.role === 'user' ? 'Клиент' : turn.source === 'deep' ? 'Агент · глубокий ответ' : 'Агент'}:{' '}
              </span>
              {turn.text}
            </p>
            {turn.diagnostics && (
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
                <span>STT {turn.diagnostics.sttModel} {turn.diagnostics.sttMs}ms</span>
                <span>LLM {turn.diagnostics.llmModel} {turn.diagnostics.llmMs}ms</span>
                <span>TTS {turn.diagnostics.ttsMs}ms</span>
                {turn.diagnostics.firstAudioMs ? <span>первый звук {turn.diagnostics.firstAudioMs}ms</span> : null}
                <span>${turn.diagnostics.costUsd.toFixed(6)}</span>
                {turn.diagnostics.fallbackUsed && <span className="text-yellow-400">STT fallback</span>}
              </div>
            )}
          </div>
        ))}
      </section>

      <p className="order-8 flex items-center gap-2 text-xs text-gray-400">
        <Activity size={13} /> Voice ID, модель LLM и устройства применяются к этой сессии фактически, а не только отображаются в форме.
        <Languages size={13} className="ml-2" /> STT: русский язык.
      </p>
    </div>
  );
}
