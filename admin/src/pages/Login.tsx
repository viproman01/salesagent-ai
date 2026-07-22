import { useState, type FormEvent } from 'react';
import api from '../api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface Props { onLogin: () => void }

export default function Login({ onLogin }: Props) {
  const [email,    setEmail]    = useState('demo@flowers.kz');
  const [password, setPassword] = useState('demo1234');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('token', data.token);
      localStorage.setItem('orgId', data.orgId);
      onLogin();
    } catch {
      setError('Неверный email или пароль');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-0 grid place-items-center relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-50"
           style={{ background: 'radial-gradient(60% 60% at 50% 30%, rgba(0,177,79,.15), transparent 70%)' }} />
      <div className="relative w-[360px] bg-bg-1 border border-line rounded-4 shadow-d-3 p-7">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-9 h-9 rounded-2 bg-accent text-accent-fg grid place-items-center font-bold">SA</div>
          <div>
            <div className="text-[15px] font-semibold">SalesAgent AI</div>
            <div className="text-[11px] text-fg-2 uppercase tracking-wider">Admin</div>
          </div>
        </div>
        <h1 className="text-[20px] font-semibold mb-1">Вход</h1>
        <p className="text-[13px] text-fg-1 mb-5">Управляй разговорами и агентами</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
          <Input label="Пароль" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          {error && <div className="text-[12px] text-danger">{error}</div>}
          <Button type="submit" loading={loading} className="w-full justify-center">
            {loading ? 'Вход…' : 'Войти'}
          </Button>
        </form>
      </div>
    </div>
  );
}
