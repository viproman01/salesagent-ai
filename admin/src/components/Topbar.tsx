import { useLocation } from 'react-router-dom';
import { Search, Bell, HelpCircle } from 'lucide-react';
import { KBD } from '../ui/KBD';

const TITLES: Record<string, string> = {
  '/dashboard':     'Дашборд',
  '/chat':          'Чат с агентом',
  '/conversations': 'Разговоры',
  '/recordings':    'Записи',
  '/knowledge':     'База знаний',
  '/agents':        'Агенты',
  '/voice-test':    'Тест звонка',
};

export default function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? '—';
  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-line bg-bg-1 sticky top-0 z-30">
      <div className="text-[13px] font-medium text-fg-1">
        <span className="text-fg-2">SalesAgent</span>
        <span className="mx-2 text-fg-2">/</span>
        <span className="text-fg-0">{title}</span>
      </div>
      <div className="flex-1 flex justify-center">
        <button
          onClick={onOpenPalette}
          className="group flex items-center gap-2 h-8 w-[420px] px-2.5 rounded-2 bg-bg-0 border border-line text-[12px] text-fg-2 hover:text-fg-1 hover:border-fg-2/30"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Поиск, действия, навигация…</span>
          <KBD>⌘</KBD><KBD>K</KBD>
        </button>
      </div>
      <button className="w-8 h-8 inline-flex items-center justify-center rounded-2 text-fg-2 hover:text-fg-0 hover:bg-bg-2" aria-label="Уведомления">
        <Bell size={15} />
      </button>
      <button className="w-8 h-8 inline-flex items-center justify-center rounded-2 text-fg-2 hover:text-fg-0 hover:bg-bg-2" aria-label="Помощь">
        <HelpCircle size={15} />
      </button>
    </header>
  );
}
