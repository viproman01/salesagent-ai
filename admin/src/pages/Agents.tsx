import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Bot, Trash2 } from 'lucide-react';
import api, { type Agent } from '../api';
import { Card, CardHeader } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { toast } from '../ui/Toast';

const DEFAULT_PROMPT = `Ты — AI-ассистент по продажам. Твоя задача — помочь клиенту и привести его к покупке.
Используй search_knowledge() для поиска информации о продуктах.
Когда клиент готов купить — вызови update_lead(stage='negotiation').`;

const CHANNELS = ['whatsapp', 'telegram', 'voice', 'webchat'] as const;

export default function Agents() {
  const qc = useQueryClient();
  const [editId, setEditId]     = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm]         = useState<Partial<Agent>>({
    name: '', system_prompt: DEFAULT_PROMPT, channels: ['whatsapp'], temperature: 0.7, max_tokens: 1024,
  });
  const [saving, setSaving]     = useState(false);
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState('');
  const [testing, setTesting]   = useState(false);

  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn:  () => api.get('/agents').then(r => r.data as { agents: Agent[] }),
  });

  const openEdit = (a: Agent) => {
    setEditId(a.id);
    setCreating(false);
    setForm(a);
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
        toast.success('Агент создан');
      } else if (editId) {
        await api.put(`/agents/${editId}`, form);
        toast.success('Агент сохранён');
      }
      void qc.invalidateQueries({ queryKey: ['agents'] });
      setCreating(false);
      setEditId(null);
    } catch {
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (id: string) => {
    if (!confirm('Деактивировать агента?')) return;
    await api.delete(`/agents/${id}`);
    void qc.invalidateQueries({ queryKey: ['agents'] });
    if (editId === id) setEditId(null);
    toast.success('Агент деактивирован');
  };

  const testAgent = async () => {
    if (!testInput.trim() || !editId) return;
    setTesting(true);
    setTestOutput('');
    try {
      const resp = await api.get('/knowledge/search', { params: { q: testInput } });
      const results = (resp.data as { results: Array<{ content: string }> }).results;
      setTestOutput(results.length > 0
        ? `Найдено в базе знаний:\n\n${results.map(r => r.content).join('\n\n---\n\n')}`
        : 'Ничего не найдено.'
      );
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
    <div className="flex h-[calc(100vh-48px)]">
      <aside className="w-64 shrink-0 flex flex-col border-r border-line bg-bg-1">
        <div className="flex items-center justify-between p-3 border-b border-line">
          <h2 className="text-[13px] font-semibold text-fg-0">Агенты</h2>
          <Button size="sm" onClick={openCreate} iconLeft={<Plus size={12} />}>Новый</Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {!data?.agents.length
            ? <EmptyState icon={<Bot size={22} />} title="Нет агентов" />
            : data.agents.map(a => (
                <button
                  key={a.id}
                  onClick={() => openEdit(a)}
                  className={`w-full text-left p-3 border-b border-line transition-colors ${editId === a.id ? 'bg-bg-2' : 'hover:bg-bg-2/60'}`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${a.is_active ? 'bg-ok' : 'bg-fg-2'}`} />
                    <span className="text-[13px] font-medium text-fg-0 truncate">{a.name}</span>
                  </div>
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {a.channels.map(ch => <Badge key={ch} tone="neutral" size="sm">{ch}</Badge>)}
                  </div>
                </button>
              ))
          }
        </div>
      </aside>

      <section className="flex-1 overflow-y-auto bg-bg-0 p-4 min-w-0">
        {!isEditing
          ? <EmptyState title="Выбери агента" description="Слева — список. Кликни, чтобы редактировать. Или создай нового." className="h-full" />
          : (
            <div className="max-w-4xl mx-auto space-y-3">
              <Card>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-[14px] font-semibold text-fg-0">{creating ? 'Новый агент' : 'Редактирование'}</h3>
                  <div className="flex gap-2">
                    {editId && (
                      <Button variant="ghost" size="sm" onClick={() => void deactivate(editId)} iconLeft={<Trash2 size={12} />}>Удалить</Button>
                    )}
                    <Button onClick={() => void save()} loading={saving} iconLeft={<Save size={13} />}>
                      {saving ? 'Сохранение…' : 'Сохранить'}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <Input
                    label="Имя агента"
                    value={form.name ?? ''}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Айгуль"
                  />
                  <div className="flex flex-col gap-1 text-[13px]">
                    <span className="text-fg-1">Каналы</span>
                    <div className="flex gap-2 items-center h-9">
                      {CHANNELS.map(ch => (
                        <label key={ch} className="flex items-center gap-1.5 cursor-pointer text-[13px] text-fg-1">
                          <input
                            type="checkbox"
                            checked={form.channels?.includes(ch) ?? false}
                            onChange={() => toggleChannel(ch)}
                            className="accent-accent"
                          />
                          <span className="capitalize">{ch}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="flex flex-col gap-1 text-[13px]">
                    <span className="text-fg-1">Температура: <span className="num text-fg-0">{form.temperature}</span></span>
                    <input
                      type="range" min={0} max={1} step={0.1}
                      value={form.temperature ?? 0.7}
                      onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                      className="w-full accent-accent"
                    />
                  </div>
                  <Input
                    label="Макс. токенов"
                    type="number"
                    value={form.max_tokens ?? 1024}
                    onChange={e => setForm(f => ({ ...f, max_tokens: parseInt(e.target.value) }))}
                  />
                </div>

                <div className="flex flex-col gap-1 text-[13px]">
                  <span className="text-fg-1">Системный промпт</span>
                  <textarea
                    value={form.system_prompt ?? ''}
                    rows={10}
                    onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))}
                    className="w-full bg-bg-0 border border-line rounded-2 p-3 text-[12px] font-mono text-fg-0 outline-none focus:border-accent resize-y"
                    placeholder="Ты — AI-ассистент…"
                  />
                </div>
              </Card>

              <Card>
                <CardHeader title="Тест базы знаний" />
                <div className="flex gap-2">
                  <Input
                    placeholder="Запрос к базе знаний…"
                    value={testInput}
                    onChange={e => setTestInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && void testAgent()}
                    className="flex-1"
                  />
                  <Button variant="secondary" onClick={() => void testAgent()} loading={testing}>Тест</Button>
                </div>
                {testOutput && (
                  <pre className="mt-3 text-[11px] text-fg-1 bg-bg-2 rounded-2 p-3 whitespace-pre-wrap border border-line max-h-60 overflow-y-auto">
                    {testOutput}
                  </pre>
                )}
              </Card>
            </div>
          )}
      </section>
    </div>
  );
}
