import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import { Upload, Trash2, FileText, Search } from 'lucide-react';

interface KnowledgeFile {
  source_file: string;
  category:    string;
  chunk_count: number;
  total_tokens: number;
  uploaded_at: string;
}

export default function Knowledge() {
  const qc          = useQueryClient();
  const fileRef     = useRef<HTMLInputElement>(null);
  const [category, setCategory]   = useState('general');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [searchQ, setSearchQ]     = useState('');
  const [searchResults, setSearchResults] = useState<Array<{content:string;category:string;source_file:string;similarity:number}>>([]);

  const { data } = useQuery({
    queryKey: ['knowledge-files'],
    queryFn:  () => api.get('/knowledge').then(r => r.data as { files: KnowledgeFile[] }),
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadMsg('');
    const form = new FormData();
    form.append('file', file);
    form.append('category', category);

    try {
      const { data: resp } = await api.post('/knowledge/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setUploadMsg(`✅ ${resp.message}`);
      void qc.invalidateQueries({ queryKey: ['knowledge-files'] });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Ошибка загрузки';
      setUploadMsg(`❌ ${msg}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Удалить "${filename}"?`)) return;
    await api.delete(`/knowledge/${encodeURIComponent(filename)}`);
    void qc.invalidateQueries({ queryKey: ['knowledge-files'] });
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    const { data: resp } = await api.get('/knowledge/search', { params: { q: searchQ } });
    setSearchResults((resp as { results: typeof searchResults }).results);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">База знаний</h1>

      {/* Загрузка */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h3 className="font-semibold text-gray-900 mb-3">Загрузить файл</h3>
        <p className="text-sm text-gray-500 mb-4">Поддерживаются PDF, CSV, TXT, Markdown (до 50 МБ)</p>
        <div className="flex gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Категория</label>
            <select
              value={category} onChange={e => setCategory(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="general">Общее</option>
              <option value="products">Товары</option>
              <option value="pricing">Цены</option>
              <option value="delivery">Доставка</option>
              <option value="faq">FAQ</option>
            </select>
          </div>
          <label className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors ${
            uploading ? 'bg-gray-100 text-gray-400' : 'bg-brand-500 hover:bg-brand-600 text-white'
          }`}>
            <Upload size={16} />
            {uploading ? 'Загрузка...' : 'Выбрать файл'}
            <input ref={fileRef} type="file" accept=".pdf,.csv,.txt,.md" onChange={handleUpload} className="hidden" disabled={uploading} />
          </label>
        </div>
        {uploadMsg && <p className="mt-3 text-sm">{uploadMsg}</p>}
      </div>

      {/* Поиск */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h3 className="font-semibold text-gray-900 mb-3">Тест поиска</h3>
        <div className="flex gap-2">
          <input
            value={searchQ} onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void handleSearch()}
            placeholder="Введите запрос для теста RAG..."
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={() => void handleSearch()}
            className="flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-700 text-white rounded-lg text-sm transition-colors"
          >
            <Search size={15} />
            Найти
          </button>
        </div>
        {searchResults.length > 0 && (
          <div className="mt-4 space-y-3">
            {searchResults.map((r, i) => (
              <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-medium text-brand-600">{r.category} · {r.source_file}</span>
                  <span className="text-xs text-gray-400">сходство: {Math.round(r.similarity * 100)}%</span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{r.content.slice(0, 300)}{r.content.length > 300 ? '…' : ''}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Список файлов */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Загруженные файлы</h3>
        </div>
        {!data?.files.length ? (
          <div className="p-8 text-center text-gray-400">
            <FileText size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Файлы не загружены</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Файл</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Категория</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Фрагментов</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Загружен</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.files.map(f => (
                <tr key={f.source_file} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{f.source_file}</td>
                  <td className="px-5 py-3 text-gray-500">{f.category}</td>
                  <td className="px-5 py-3 text-gray-500">{f.chunk_count}</td>
                  <td className="px-5 py-3 text-gray-400 text-xs">
                    {new Date(f.uploaded_at).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => void handleDelete(f.source_file)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
