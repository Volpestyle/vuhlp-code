import { useEffect } from 'react';
import { useRunStore } from '../stores/runStore';
import { applyTheme, THEME_STORAGE_KEY } from '../lib/theme';

export const useTheme = () => {
  const theme = useRunStore((s) => s.ui.theme);
  const setTheme = useRunStore((s) => s.setTheme);
  const toggleTheme = useRunStore((s) => s.toggleTheme);

  useEffect(() => {
    applyTheme(theme);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors (private mode or blocked storage).
    }
  }, [theme]);

  return { theme, setTheme, toggleTheme };
};
