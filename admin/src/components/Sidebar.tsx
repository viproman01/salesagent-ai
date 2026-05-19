import { NavLink, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  LayoutDashboard, MessageSquare, Mic, BookOpen, Bot, LogOut,
  Phone, MessagesSquare, PanelLeftClose, PanelLeftOpen, Moon, Sun
} from 'lucide-react';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { useTheme } from '../hooks/useTheme';
import { cn } from '../ui/cn';

const links = [
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Дашборд' },
  { to: '/chat',          icon: MessagesSquare,  label: 'Чат' },
  { to: '/conversations', icon: MessageSquare,   label: 'Разговоры' },
  { to: '/recordings',    icon: Mic,             label: 'Записи' },
  { to: '/knowledge',     icon: BookOpen,        label: 'База знаний' },
  { to: '/agents',        icon: Bot,             label: 'Агенты' },
  { to: '/voice-test',    icon: Phone,           label: 'Тест звонка' },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sb-collapsed') === '1'
  );
  const { theme, setTheme } = useTheme();

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sb-collapsed', next ? '1' : '0');
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('orgId');
    navigate('/login');
  };

  return (
    <TooltipProvider>
      <aside
        className={cn(
          'flex flex-col h-full shrink-0 bg-bg-1 border-r border-line transition-[width] duration-150 ease-sharp',
          collapsed ? 'w-14' : 'w-[220px]'
        )}
      >
        <div className="h-12 flex items-center px-3 border-b border-line">
          <div className="w-8 h-8 rounded-2 bg-accent text-accent-fg flex items-center justify-center text-[14px] font-bold shrink-0">SA</div>
          {!collapsed && (
            <div className="ml-2 leading-tight">
              <div className="text-[13px] font-semibold text-fg-0">SalesAgent</div>
              <div className="text-[10px] text-fg-2 uppercase tracking-wider">Admin</div>
            </div>
          )}
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {links.map(({ to, icon: Icon, label }) => {
            const item = (
              <NavLink
                to={to}
                className={({ isActive }) => cn(
                  'group relative flex items-center gap-2 h-9 rounded-2 text-[13px]',
                  collapsed ? 'justify-center px-0' : 'px-2.5',
                  isActive
                    ? 'bg-bg-2 text-fg-0 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-accent before:rounded-r'
                    : 'text-fg-1 hover:text-fg-0 hover:bg-bg-2'
                )}
              >
                <Icon size={16} className="shrink-0" />
                {!collapsed && <span>{label}</span>}
              </NavLink>
            );
            return collapsed
              ? <Tooltip key={to} label={label} side="right">{item}</Tooltip>
              : <div key={to}>{item}</div>;
          })}
        </nav>

        <div className="px-2 py-2 border-t border-line space-y-0.5">
          <button
            onClick={toggleCollapse}
            className="flex items-center gap-2 h-8 w-full px-2 rounded-2 text-[12px] text-fg-2 hover:text-fg-0 hover:bg-bg-2"
            title={collapsed ? 'Развернуть' : 'Свернуть'}
          >
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            {!collapsed && <span>Свернуть</span>}
          </button>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex items-center gap-2 h-8 w-full px-2 rounded-2 text-[12px] text-fg-2 hover:text-fg-0 hover:bg-bg-2"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {!collapsed && <span>{theme === 'dark' ? 'Светлая' : 'Тёмная'}</span>}
          </button>
          <button
            onClick={logout}
            className="flex items-center gap-2 h-8 w-full px-2 rounded-2 text-[12px] text-fg-2 hover:text-danger hover:bg-danger/10"
          >
            <LogOut size={14} />
            {!collapsed && <span>Выйти</span>}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
