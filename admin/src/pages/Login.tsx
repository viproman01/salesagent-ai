import { useState } from 'react';
import api from '../api';
import { Bot } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';

interface Props { onLogin: () => void }

export default function Login({ onLogin }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.removeItem('token');
      localStorage.setItem('orgId', data.orgId);
      onLogin();
    } catch {
      setError('Неверный email или пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="absolute right-4 top-4"><ThemeToggle compact /></div>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500 text-white shadow-md">
            <Bot size={24} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">SalesAgent AI</h1>
          <p className="text-gray-500 text-sm mt-1">Панель управления</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Пароль</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              required
            />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            type="submit" disabled={loading}
            className="w-full bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>
        <p className="mt-5 text-center text-sm text-gray-500">
          Нет аккаунта?{' '}
          <a href="/register" className="font-medium text-brand-600 hover:text-brand-700">
            Создать организацию
          </a>
        </p>
      </div>
    </div>
  );
}
