import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import type { Agent } from '../api';
import { Plus, Save, Bot, Trash2 } from 'lucide-react';

const DEFAULT_PROMPT = `Ты — AI-ассистент по продажам. Твоя задача — помочь клиенту и привести его к покупке.
Используй search_knowledge() для поиска информации о продуктах.
Когда клиент готов купить — вызови update_lead(stage='negotiation').`;

const CHANNELS = ['whatsapp', 'telegram', 'voice'] as const;

export default function Agents() {
  const qc = useQueryClient();
  const [editId, setEditId]   = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm]       = useState<Partial<Agent>>({
    name: '', system_prompt: DEFAULT_PROMPT, channels: ['whatsapp'], temperature: 0.7, max_tokens: 1024,
  });
  const [saving, setSaving]   = useState(false);
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState('');
  const [testing, setTesting]   = useState(false);

  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn:  () => api.get('/agents').then(r => r.data as { agents: Agent[] }),
  });

  const openEdit = (agent: Agent) => {
    setEditId(agent.id);
    setCreating(false);
    setForm(agent);
    setTestOutput('');
  };

  const openCreate = () => {
    setEditId(null);
    setCreating(true);
    setForm({ name: '', system_prompt: DEFAULT_PROMPT, channels: ['whatsapp'], temperature: 0.7, max_tokens: 1024 });
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
      // Простой тест через knowledge search
      const resp = await api.get('/knowledge/search', { params: { q: testInput } });
      const results = (resp.data as { results: Array<{content:string}> }).results;
      if (results.length > 0) {
        setTestOutput(`Найдено в базе знаний:\n\n${results.map(r => r.content).join('\n\n---\n\n')}`);
      } else {
        setTestOutput('Ничего не найдено в базе знаний по этому запросу.');
      }
    } catch {
      setTestOutput('Ошибка теста');
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
            <h3 className="font-semibold text-gray-900 mb-3">Тест базы знаний</h3>
            <div className="flex gap-2">
              <input
                value={testInput} onChange={e => setTestInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void testAgent()}
                placeholder="Спросить что-то из базы знаний..."
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
