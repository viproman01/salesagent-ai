import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme';

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      title={isDark ? 'Светлая тема' : 'Тёмная тема'}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white text-gray-600 shadow-sm transition-all hover:border-brand-500 hover:text-brand-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 ${
        compact ? 'h-9 w-9' : 'h-10 px-3 text-sm'
      }`}
    >
      {isDark ? <Sun size={17} /> : <Moon size={17} />}
      {compact ? null : <span>{isDark ? 'Светлая' : 'Тёмная'}</span>}
    </button>
  );
}
