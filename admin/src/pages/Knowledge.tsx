import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, FileText, Search } from 'lucide-react';
import api from '../api';
import UploadDropzone from '../components/UploadDropzone';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { toast } from '../ui/Toast';

interface KnowledgeFile {
  source_file: string;
  category:    string;
  chunk_count: number;
  total_tokens: number;
  uploaded_at: string;
}

const CATEGORIES = [
  { key: 'general',  label: 'Общее' },
  { key: 'products', label: 'Товары' },
  { key: 'pricing',  label: 'Цены' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'faq',      label: 'FAQ' },
];

export default function Knowledge() {
  const qc = useQueryClient();
  const [category, setCategory] = useState('general');
  const [uploading, setUploading] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ content: string; category: string; source_file: string; similarity: number }>>([]);

  const { data } = useQuery({
    queryKey: ['knowledge-files'],
    queryFn:  () => api.get('/knowledge').then(r => r.data as { files: KnowledgeFile[] }),
  });

  const uploadFiles = async (files: File[]) => {
    setUploading(true);
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      form.append('category', category);
      try {
        const { data: resp } = await api.post('/knowledge/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        toast.success(`${file.name}: ${resp.message ?? 'загружен'}`);
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'ошибка загрузки';
        toast.error(`${file.name}: ${msg}`);
      }
    }
    setUploading(false);
    void qc.invalidateQueries({ queryKey: ['knowledge-files'] });
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Удалить "${filename}"?`)) return;
    try {
      await api.delete(`/knowledge/${encodeURIComponent(filename)}`);
      toast.success(`${filename} удалён`);
      void qc.invalidateQueries({ queryKey: ['knowledge-files'] });
    } catch {
      toast.error('Не удалось удалить');
    }
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    const { data: resp } = await api.get('/knowledge/search', { params: { q: searchQ } });
    setSearchResults((resp as { results: typeof searchResults }).results);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-4">
      <Card padding="sm">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-[11px] uppercase tracking-wider text-fg-2">Категория</span>
          {CATEGORIES.map(c => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`h-7 px-2.5 text-[12px] rounded-full border transition-colors ${
                category === c.key ? 'bg-bg-2 text-fg-0 border-fg-2/30' : 'border-transparent text-fg-2 hover:text-fg-0'
              }`}
            >{c.label}</button>
          ))}
        </div>
        <UploadDropzone onFiles={uploadFiles} accept=".pdf,.csv,.txt,.md" hint={uploading ? 'Загрузка…' : `Категория: ${CATEGORIES.find(c => c.key === category)?.label}`} />
      </Card>

      <Card>
        <CardHeader title="Тест поиска (RAG)" />
        <div className="flex gap-2">
          <Input
            placeholder="Запрос для теста…"
            leftSlot={<Search size={13} />}
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void handleSearch()}
            className="flex-1"
          />
          <Button onClick={() => void handleSearch()}>Найти</Button>
        </div>
        {searchResults.length > 0 && (
          <div className="mt-3 space-y-2">
            {searchResults.map((r, i) => (
              <div key={i} className="bg-bg-2 rounded-2 p-3 border border-line">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[11px] text-accent">{r.category} · {r.source_file}</span>
                  <span className="num text-[11px] text-fg-2">{Math.round(r.similarity * 100)}%</span>
                </div>
                <p className="text-[12px] text-fg-1 leading-relaxed">{r.content.slice(0, 300)}{r.content.length > 300 ? '…' : ''}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card padding="none">
        <div className="px-5 py-3 border-b border-line">
          <h3 className="text-[14px] font-semibold text-fg-0">Загруженные файлы</h3>
        </div>
        {!data?.files.length
          ? <EmptyState icon={<FileText size={22} />} title="Файлы не загружены" description="Загрузите PDF, DOCX или MD, чтобы агент мог опираться на них." />
          : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-fg-2 bg-bg-2 border-b border-line">
                  <th className="text-left px-5 py-2 font-medium">Файл</th>
                  <th className="text-left px-5 py-2 font-medium">Категория</th>
                  <th className="text-left px-5 py-2 font-medium num">Фрагменты</th>
                  <th className="text-left px-5 py-2 font-medium">Загружен</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.files.map(f => (
                  <tr key={f.source_file} className="hover:bg-bg-2/60">
                    <td className="px-5 py-3 text-fg-0">{f.source_file}</td>
                    <td className="px-5 py-3"><Badge tone="neutral" size="sm">{f.category}</Badge></td>
                    <td className="px-5 py-3 num text-fg-1">{f.chunk_count}</td>
                    <td className="px-5 py-3 num text-[11px] text-fg-2">{new Date(f.uploaded_at).toLocaleDateString('ru-RU')}</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => void handleDelete(f.source_file)} className="text-fg-2 hover:text-danger transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Card>
    </div>
  );
}
