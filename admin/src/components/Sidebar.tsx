import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, MessageSquare, Mic, BookOpen, Bot, LogOut, Phone, MessagesSquare
} from 'lucide-react';

const links = [
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Дашборд' },
  { to: '/chat',          icon: MessagesSquare,  label: 'Чат с агентом' },
  { to: '/conversations', icon: MessageSquare,   label: 'Разговоры' },
  { to: '/recordings',    icon: Mic,             label: 'Записи' },
  { to: '/knowledge',     icon: BookOpen,        label: 'База знаний' },
  { to: '/agents',        icon: Bot,             label: 'Агенты' },
  { to: '/voice-test',    icon: Phone,           label: 'Тест звонка' },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('orgId');
    navigate('/login');
  };

  return (
    <aside className="w-60 bg-gray-900 text-white flex flex-col h-full shrink-0">
      <div className="p-5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🤖</span>
          <div>
            <div className="font-bold text-sm">SalesAgent AI</div>
            <div className="text-xs text-gray-400">Панель управления</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to} to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-gray-800">
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 w-full transition-colors"
        >
          <LogOut size={18} />
          Выйти
        </button>
      </div>
    </aside>
  );
}
