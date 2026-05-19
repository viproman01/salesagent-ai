import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import {
  LayoutDashboard, MessageSquare, Mic, BookOpen, Bot, Phone, MessagesSquare,
  Moon, Sun, LogOut
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  const go = (path: string) => {
    navigate(path);
    onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Командная палитра"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => onOpenChange(false)} />
      <div className="relative w-[92vw] max-w-[560px] bg-bg-1 border border-line rounded-3 shadow-d-3 overflow-hidden">
        <Command.Input
          placeholder="Команда, страница, поиск…"
          className="w-full h-12 px-4 bg-transparent text-[14px] text-fg-0 placeholder:text-fg-2 outline-none border-b border-line"
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-1">
          <Command.Empty className="text-center py-6 text-[13px] text-fg-2">Ничего не найдено.</Command.Empty>

          <Command.Group heading="Навигация" className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-fg-2">
            <Item icon={<LayoutDashboard size={14} />} label="Дашборд"     onSelect={() => go('/dashboard')} />
            <Item icon={<MessageSquare size={14} />}   label="Разговоры"   onSelect={() => go('/conversations')} />
            <Item icon={<Mic size={14} />}             label="Записи"      onSelect={() => go('/recordings')} />
            <Item icon={<BookOpen size={14} />}        label="База знаний" onSelect={() => go('/knowledge')} />
            <Item icon={<Bot size={14} />}             label="Агенты"      onSelect={() => go('/agents')} />
            <Item icon={<Phone size={14} />}           label="Тест звонка" onSelect={() => go('/voice-test')} />
            <Item icon={<MessagesSquare size={14} />}  label="Чат"         onSelect={() => go('/chat')} />
          </Command.Group>

          <Command.Group heading="Действия" className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-fg-2">
            <Item
              icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
              onSelect={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); onOpenChange(false); }}
            />
            <Item
              icon={<LogOut size={14} />}
              label="Выйти"
              onSelect={() => {
                localStorage.removeItem('token');
                localStorage.removeItem('orgId');
                go('/login');
              }}
            />
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

function Item({ icon, label, onSelect }: { icon: ReactNode; label: string; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2 px-2.5 h-9 rounded-2 text-[13px] text-fg-1 data-[selected=true]:bg-bg-2 data-[selected=true]:text-fg-0 cursor-pointer"
    >
      {icon}
      <span>{label}</span>
    </Command.Item>
  );
}
