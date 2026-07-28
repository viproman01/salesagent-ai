import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import type { Agent } from '../api';
import { Plus, Save, Bot, Trash2 } from 'lucide-react';

const DEFAULT_PROMPT = `Ты — AI-ассистент по продажам. Твоя задача — помочь клиенту и привести его к покупке.
Используй search_knowledge() для поиска информации о продуктах.
Когда клиент готов купить — вызови update_lead(stage='negotiation').`;

const CHANNELS = ['whatsapp', 'telegram', 'voice'] as const;
type TextProvider = 'openrouter' | 'cerebras';

interface CatalogModel {
  id: string;
  name: string;
  supportsTools: boolean;
  recommended: boolean;
}

interface ProviderCatalog {
  id: TextProvider;
  name: string;
  configured: boolean;
  keyCount: number;
  models: CatalogModel[];
  catalogAvailable: boolean;
}

const CEREBRAS_FALLBACK_MODELS: CatalogModel[] = [
  { id: 'gemma-4-31b', name: 'Gemma 4 31B', supportsTools: true, recommended: true },
  { id: 'gpt-oss-120b', name: 'GPT OSS 120B', supportsTools: true, recommended: false },
  { id: 'zai-glm-4.7', name: 'Z.ai GLM 4.7', supportsTools: true, recommended: false },
];
const CARTESIA_MOMMY_VOICE_ID = '779673f3-895f-4935-b6b5-b031dc78b319';
const FISH_MOMMY_VOICE_ID = '3cea70d91116442f8086820844db233c';

function parseModelReference(reference?: string): { provider: TextProvider; model: string } {
  const value = reference?.trim() || 'openrouter/auto';
  if (value.startsWith('cerebras/') && value.length > 'cerebras/'.length) {
    return { provider: 'cerebras', model: value.slice('cerebras/'.length) };
  }
  return { provider: 'openrouter', model: value };
}

function formatModelReference(provider: TextProvider, model: string): string {
  return provider === 'cerebras' ? `cerebras/${model}` : model;
}

function defaultVoiceConfig(): Agent['voice_config'] {
  return {
    version: 2,
    provider: 'cartesia',
    model: 'sonic-3.5',
    voiceId: CARTESIA_MOMMY_VOICE_ID,
    language: 'ru-RU',
    speed: 1.08,
    stt: { provider: 'openrouter', model: 'deepgram/nova-3', language: 'ru' },
    vad: { silenceMs: 480, maxUtteranceSeconds: 30 },
    orchestration: {
      fastModel: 'cerebras/gemma-4-31b',
      deepModel: 'deepseek/deepseek-v4-pro',
      complexRouting: true,
    },
  };
}

export default function Agents() {
  const qc = useQueryClient();
  const [editId, setEditId]   = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm]       = useState<Partial<Agent>>({
    name: '', system_prompt: DEFAULT_PROMPT, channels: ['whatsapp'], temperature: 0.7, max_tokens: 1024,
    model_text: 'openrouter/auto', voice_config: defaultVoiceConfig(),
  });
  const [saving, setSaving]   = useState(false);
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState('');
  const [testing, setTesting]   = useState(false);

  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn:  () => api.get('/agents').then(r => r.data as { agents: Agent[] }),
  });
  const { data: catalogs, isLoading: catalogsLoading } = useQuery({
    queryKey: ['provider-models'],
    queryFn: () => api.get('/providers/models').then(
      response => response.data as { providers: ProviderCatalog[] }
    ),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const { data: fishVoices } = useQuery({
    queryKey: ['fish-voices'],
    queryFn: () => api.get('/providers/fish/voices').then(
      response => response.data as {
        voices: Array<{ id: string; name: string; languages: string[] }>;
      }
    ),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const { data: cartesiaVoices } = useQuery({
    queryKey: ['cartesia-voices'],
    queryFn: () => api.get('/providers/cartesia/voices').then(
      response => response.data as {
        voices: Array<{
          id: string;
          name: string;
          language: string;
          gender: 'masculine' | 'feminine' | 'gender_neutral' | null;
        }>;
        model: string;
        catalogAvailable: boolean;
      }
    ),
    staleTime: 10 * 60_000,
    retry: false,
  });

  const openEdit = (agent: Agent) => {
    setEditId(agent.id);
    setCreating(false);
    setForm({
      ...agent,
      voice_config: {
        ...defaultVoiceConfig(),
        ...agent.voice_config,
        stt: { ...defaultVoiceConfig().stt!, ...agent.voice_config?.stt },
        vad: { ...defaultVoiceConfig().vad!, ...agent.voice_config?.vad },
        orchestration: {
          ...defaultVoiceConfig().orchestration!,
          ...agent.voice_config?.orchestration,
        },
      },
    });
    setTestOutput('');
  };

  const openCreate = () => {
    setEditId(null);
    setCreating(true);
    setForm({ name: '', system_prompt: DEFAULT_PROMPT, channels: ['whatsapp'], temperature: 0.7, max_tokens: 1024, model_text: 'openrouter/auto', voice_config: defaultVoiceConfig() });
  };

  const save = async () => {
    setSaving(true);
    try {
      if (creating) {
        await api.post('/agents', form);
      } else if (editId) {
        await api.put(`/agents/${editId}`, form);
      }
      void qc.invalidateQueries({ queryKey: ['agents'] });
      setCreating(false);
      setEditId(null);
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (id: string) => {
    if (!confirm('Деактивировать агента?')) return;
    await api.delete(`/agents/${id}`);
    void qc.invalidateQueries({ queryKey: ['agents'] });
    if (editId === id) setEditId(null);
  };

  const testAgent = async () => {
    if (!testInput.trim() || !editId) return;
    setTesting(true);
    setTestOutput('');
    try {
      const resp = await api.post('/chat', {
        agentId: editId,
        message: testInput.trim(),
        sessionId: `agent-test-${Date.now()}`,
      });
      const result = resp.data as { reply: string; toolsUsed: string[] };
      setTestOutput(`${result.reply}\n\nИнструменты: ${result.toolsUsed.join(', ') || 'не использовались'}`);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
      setTestOutput(`Ошибка теста: ${message ?? 'запрос не выполнен'}`);
    } finally {
      setTesting(false);
    }
  };

  const toggleChannel = (ch: string) => {
    setForm(f => ({
      ...f,
      channels: f.channels?.includes(ch as typeof CHANNELS[number])
        ? f.channels.filter(c => c !== ch)
        : [...(f.channels ?? []), ch as typeof CHANNELS[number]],
    }));
  };

  const isEditing = creating || !!editId;
  const modelSelection = parseModelReference(form.model_text);
  const selectedCatalog = catalogs?.providers.find(item => item.id === modelSelection.provider);
  const availableModels = modelSelection.provider === 'cerebras'
    ? selectedCatalog?.models.length ? selectedCatalog.models : CEREBRAS_FALLBACK_MODELS
    : selectedCatalog?.models ?? [];
  const ttsProvider = form.voice_config?.provider ?? 'cartesia';
  const ttsVoices = ttsProvider === 'cartesia'
    ? (cartesiaVoices?.voices ?? []).map(voice => ({
        id: voice.id,
        label: `${voice.name} · ru${voice.gender === 'feminine' ? ' · женский' : voice.gender === 'masculine' ? ' · мужской' : ''}`,
      }))
    : (fishVoices?.voices ?? []).map(voice => ({
        id: voice.id,
        label: `${voice.name} · ${voice.languages.join(', ') || 'язык не указан'}`,
      }));

  return (
    <div className="flex gap-4 h-[calc(100vh-6rem)]">
      {/* Список агентов */}
      <div className="w-64 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-gray-900">Агенты</h1>
          <button
            onClick={openCreate}
            className="flex items-center gap-1 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <Plus size={13} /> Новый
          </button>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex-1 overflow-y-auto">
          {!data?.agents.length ? (
            <div className="p-6 text-center text-gray-400">
              <Bot size={28} className="mx-auto mb-2 opacity-30" />
              <p className="text-xs">Нет агентов</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {data.agents.map(a => (
                <button
                  key={a.id} onClick={() => openEdit(a)}
                  className={`w-full text-left p-4 hover:bg-gray-50 transition-colors ${
                    editId === a.id ? 'bg-brand-50 border-l-2 border-brand-500' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${a.is_active ? 'bg-green-400' : 'bg-gray-300'}`} />
                    <span className="font-medium text-sm text-gray-900">{a.name}</span>
                  </div>
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {a.channels.map(ch => (
                      <span key={ch} className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-xs">{ch}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Редактор */}
      {isEditing && (
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">{creating ? 'Новый агент' : 'Редактировать агента'}</h3>
              <div className="flex gap-2">
                {editId && (
                  <button onClick={() => void deactivate(editId)} className="text-gray-400 hover:text-red-500 transition-colors">
                    <Trash2 size={16} />
                  </button>
                )}
                <button
                  onClick={() => void save()} disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  <Save size={14} /> {saving ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">AI-провайдер и модель</label>
                <div className="grid grid-cols-[132px_1fr] gap-2">
                  <select
                    value={modelSelection.provider}
                    onChange={event => {
                      const provider = event.target.value as TextProvider;
                      const model = provider === 'cerebras' ? 'gemma-4-31b' : 'openrouter/auto';
                      setForm(current => ({ ...current, model_text: formatModelReference(provider, model) }));
                    }}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="cerebras">Cerebras</option>
                    <option value="openrouter">OpenRouter</option>
                  </select>
                  <input
                    list={`models-${modelSelection.provider}`}
                    value={modelSelection.model}
                    onChange={event => setForm(current => ({
                      ...current,
                      model_text: formatModelReference(modelSelection.provider, event.target.value),
                    }))}
                    className="min-w-0 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder={modelSelection.provider === 'cerebras' ? 'gemma-4-31b' : 'provider/model-id'}
                  />
                  <datalist id={`models-${modelSelection.provider}`}>
                    {availableModels.map(model => (
                      <option
                        key={model.id}
                        value={model.id}
                        label={`${model.recommended ? '★ ' : ''}${model.name}${model.supportsTools ? ' · tools' : ''}`}
                      />
                    ))}
                  </datalist>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {catalogsLoading
                    ? 'Загружаем доступные модели…'
                    : selectedCatalog?.configured
                      ? `${selectedCatalog.name}: подключено ключей — ${selectedCatalog.keyCount}. Начните вводить ID для поиска.`
                      : `${modelSelection.provider === 'cerebras' ? 'CEREBRAS_API_KEYS' : 'OPENROUTER_API_KEY'} не подключён на сервере.`}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Провайдер TTS</label>
                <select
                  value={ttsProvider}
                  onChange={event => {
                    const provider = event.target.value as 'cartesia' | 'fish';
                    setForm(current => ({
                      ...current,
                      voice_config: {
                        ...defaultVoiceConfig(),
                        ...current.voice_config,
                        provider,
                        model: provider === 'cartesia' ? 'sonic-3.5' : 's2.1-pro-free',
                        voiceId: provider === 'cartesia'
                          ? CARTESIA_MOMMY_VOICE_ID
                          : FISH_MOMMY_VOICE_ID,
                      },
                    }));
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="cartesia">Cartesia · Sonic 3.5 · streaming</option>
                  <option value="fish">Fish Audio · S2.1 Pro Free · fallback</option>
                </select>
                <label className="mt-3 block text-xs font-medium text-gray-600 mb-1">
                  {ttsProvider === 'cartesia' ? 'Русский голос Cartesia' : 'Голос Fish Audio'}
                </label>
                <input
                  list={`tts-agent-voices-${ttsProvider}`}
                  value={form.voice_config?.voiceId ?? ''}
                  onChange={event => setForm(current => ({
                    ...current,
                    voice_config: {
                      ...defaultVoiceConfig(),
                      ...current.voice_config,
                      voiceId: event.target.value || undefined,
                    },
                  }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder={ttsProvider === 'cartesia' ? 'Cartesia voice UUID' : 'Fish Audio reference ID'}
                />
                <datalist id={`tts-agent-voices-${ttsProvider}`}>
                  {ttsVoices.map(voice => (
                    <option key={voice.id} value={voice.id}>{voice.label}</option>
                  ))}
                </datalist>
                <p className="text-xs text-gray-400 mt-1">
                  {ttsProvider === 'cartesia'
                    ? 'Sonic 3.5 отдаёт MP3 потоком; при сбое автоматически используется Fish Audio.'
                    : 'Fish Audio остаётся доступным как основной провайдер или автоматический резерв.'}
                </p>
              </div>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">STT через OpenRouter</label>
                <input
                  value={form.voice_config?.stt?.model ?? 'deepgram/nova-3'}
                  onChange={event => setForm(current => ({
                    ...current,
                    voice_config: {
                      ...defaultVoiceConfig(),
                      ...current.voice_config,
                      stt: {
                        provider: 'openrouter',
                        language: current.voice_config?.stt?.language ?? 'ru',
                        model: event.target.value,
                      },
                    },
                  }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Пауза для конца реплики, мс</label>
                <input
                  type="number"
                  min={400}
                  max={5000}
                  value={form.voice_config?.vad?.silenceMs ?? 1200}
                  onChange={event => setForm(current => ({
                    ...current,
                    voice_config: {
                      ...defaultVoiceConfig(),
                      ...current.voice_config,
                      vad: {
                        maxUtteranceSeconds: current.voice_config?.vad?.maxUtteranceSeconds ?? 30,
                        silenceMs: Number(event.target.value),
                      },
                    },
                  }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Макс. реплика, секунд</label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={form.voice_config?.vad?.maxUtteranceSeconds ?? 30}
                  onChange={event => setForm(current => ({
                    ...current,
                    voice_config: {
                      ...defaultVoiceConfig(),
                      ...current.voice_config,
                      vad: {
                        silenceMs: current.voice_config?.vad?.silenceMs ?? 1200,
                        maxUtteranceSeconds: Number(event.target.value),
                      },
                    },
                  }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Имя агента</label>
                <input
                  value={form.name ?? ''} onChange={e => setForm(f => ({...f, name: e.target.value}))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Айгуль"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Каналы</label>
                <div className="flex gap-2">
                  {CHANNELS.map(ch => (
                    <label key={ch} className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.channels?.includes(ch) ?? false}
                        onChange={() => toggleChannel(ch)}
                        className="accent-brand-500"
                      />
                      <span className="text-xs text-gray-600 capitalize">{ch}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Температура: {form.temperature}
                </label>
                <input
                  type="range" min={0} max={1} step={0.1}
                  value={form.temperature ?? 0.7}
                  onChange={e => setForm(f => ({...f, temperature: parseFloat(e.target.value)}))}
                  className="w-full accent-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Макс. токенов</label>
                <input
                  type="number" min={64} max={4096} step={64}
                  value={form.max_tokens ?? 1024}
                  onChange={e => setForm(f => ({...f, max_tokens: parseInt(e.target.value)}))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Системный промпт</label>
              <textarea
                value={form.system_prompt ?? ''} rows={10}
                onChange={e => setForm(f => ({...f, system_prompt: e.target.value}))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                placeholder="Ты — AI-ассистент..."
              />
            </div>
          </div>

          {/* Тест-панель */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-3">Тест агента</h3>
            <div className="flex gap-2">
              <input
                value={testInput} onChange={e => setTestInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void testAgent()}
                placeholder="Отправить реальную тестовую реплику агенту..."
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                onClick={() => void testAgent()} disabled={testing}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-700 text-white rounded-lg text-sm disabled:opacity-50 transition-colors"
              >
                {testing ? '...' : 'Тест'}
              </button>
            </div>
            {testOutput && (
              <pre className="mt-3 text-xs text-gray-700 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap border border-gray-200 max-h-48 overflow-y-auto">
                {testOutput}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
