export type ThemeMode = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'vuhlp-theme';

export const getStoredTheme = (): ThemeMode | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch {
    return null;
  }
  return null;
};

export const getInitialTheme = (): ThemeMode => getStoredTheme() ?? 'dark';

export const applyTheme = (theme: ThemeMode) => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
};
