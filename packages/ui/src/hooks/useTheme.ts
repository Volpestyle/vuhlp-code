import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light' | 'midnight' | 'terminal';

const THEME_STORAGE_KEY = 'vuhlp-theme';

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored && isValidTheme(stored)) {
    return stored;
  }
  // Check system preference
  if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function isValidTheme(value: string): value is Theme {
  return ['dark', 'light', 'midnight', 'terminal'].includes(value);
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): [Theme, (theme: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Apply initial theme on mount
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      // Simple toggle between dark and light
      return current === 'light' ? 'dark' : 'light';
    });
  }, []);

  return [theme, setTheme, toggleTheme];
}

// Available themes with metadata
export const THEMES: { id: Theme; label: string; description: string }[] = [
  { id: 'dark', label: 'Dark', description: 'Default dark theme' },
  { id: 'light', label: 'Light', description: 'Light theme' },
  { id: 'midnight', label: 'Midnight', description: 'Deeper blacks, purple accent' },
  { id: 'terminal', label: 'Terminal', description: 'Green accent, retro feel' },
];
