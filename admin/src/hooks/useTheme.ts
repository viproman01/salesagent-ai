import { useEffect, useState } from 'react';
import { getTheme, setTheme as apply, type Theme } from '../lib/theme';

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getTheme());
  useEffect(() => { apply(theme); }, [theme]);
  return { theme, setTheme: setThemeState };
}
