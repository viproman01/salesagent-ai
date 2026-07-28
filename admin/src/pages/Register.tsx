import { useState } from 'react';
import api from '../api';
import ThemeToggle from '../components/ThemeToggle';

interface Props { onRegister: () => void }

export default function Register({ onRegister }: Props) {
  const [orgName, setOrgName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', { orgName, fullName, email, password });
      localStorage.removeItem('token');
      localStorage.setItem('orgId', data.orgId);
      onRegister();
    } catch (requestError: unknown) {
      const responseError = requestError as { response?: { data?: { error?: string } } };
      setError(responseError.response?.data?.error ?? 'Не удалось создать аккаунт');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="absolute right-4 top-4"><ThemeToggle compact /></div>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-gray-900">Создать организацию</h1>
        <p className="text-sm text-gray-500 mt-1 mb-6">Первый пользователь станет администратором.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input value={orgName} onChange={event => setOrgName(event.target.value)} required minLength={2} autoComplete="organization" aria-label="Название организации" placeholder="Название организации" className="w-full border border-gray-300 rounded-lg px-3 py-2" />
          <input value={fullName} onChange={event => setFullName(event.target.value)} required minLength={2} autoComplete="name" aria-label="Ваше имя" placeholder="Ваше имя" className="w-full border border-gray-300 rounded-lg px-3 py-2" />
          <input type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email" aria-label="Email" placeholder="Email" className="w-full border border-gray-300 rounded-lg px-3 py-2" />
          <input type="password" value={password} onChange={event => setPassword(event.target.value)} required minLength={8} autoComplete="new-password" aria-label="Пароль" placeholder="Пароль — минимум 8 символов" className="w-full border border-gray-300 rounded-lg px-3 py-2" />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading} className="w-full bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 rounded-lg disabled:opacity-50">
            {loading ? 'Создание...' : 'Создать аккаунт'}
          </button>
        </form>
        <p className="mt-5 text-center text-sm text-gray-500">
          Уже есть аккаунт? <a href="/login" className="font-medium text-brand-600">Войти</a>
        </p>
      </div>
    </div>
  );
}
