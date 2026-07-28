import {
  LayoutDashboard, MessageSquare, Mic, BookOpen, Bot, LogOut, Phone, MessagesSquare, CircleHelp, Menu, X
} from 'lucide-react';
import { useState } from 'react';
import ThemeToggle from './ThemeToggle';
import api from '../api';

const links = [
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Дашборд' },
  { to: '/chat',          icon: MessagesSquare,  label: 'Чат с агентом' },
  { to: '/conversations', icon: MessageSquare,   label: 'Разговоры' },
  { to: '/recordings',    icon: Mic,             label: 'Записи' },
  { to: '/knowledge',     icon: BookOpen,        label: 'База знаний' },
  { to: '/agents',        icon: Bot,             label: 'Агенты' },
  { to: '/voice-test',    icon: Phone,           label: 'Тест звонка' },
  { to: '/help',          icon: CircleHelp,      label: 'Справка и настройка' },
];

export default function Sidebar() {
  const [open, setOpen] = useState(false);
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    localStorage.removeItem('token');
    localStorage.removeItem('orgId');
    window.location.assign('/login');
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
        className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-xl bg-gray-900 text-white shadow-lg lg:hidden"
      >
        {open ? <X size={19} /> : <Menu size={19} />}
      </button>
      {open ? <button type="button" aria-label="Закрыть меню" onClick={() => setOpen(false)} className="fixed inset-0 z-30 bg-black/50 lg:hidden" /> : null}
      <aside className={`fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col bg-gray-900 text-white transition-transform lg:static lg:w-60 lg:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}>
      <div className="p-5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 text-white"><Bot size={19} /></span>
          <div>
            <div className="font-bold text-sm">SalesAgent AI</div>
            <div className="text-xs text-gray-400">Панель управления</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1" aria-label="Основная навигация">
        {links.map(({ to, icon: Icon, label }) => (
          <a
            key={to}
            href={to}
            onClick={() => setOpen(false)}
            className={
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                window.location.pathname === to
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </a>
        ))}
      </nav>

      <div className="space-y-2 border-t border-gray-800 p-3">
        <div className="flex items-center justify-between rounded-lg bg-gray-800/70 p-2">
          <span className="pl-1 text-xs text-gray-400">Оформление</span>
          <ThemeToggle compact />
        </div>
        <button
          onClick={() => void logout()}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 w-full transition-colors"
        >
          <LogOut size={18} />
          Выйти
        </button>
      </div>
      </aside>
    </>
  );
}
