import { useTheme } from '../../hooks/useTheme';
import './ThemeToggle.css';

export interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className = '' }: ThemeToggleProps) {
  const [theme, , toggleTheme] = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      className={`vuhlp-theme-toggle ${className}`}
      onClick={toggleTheme}
      aria-label={`Switch to ${isLight ? 'dark' : 'light'} mode`}
      title={`Switch to ${isLight ? 'dark' : 'light'} mode`}
    >
      <span className="vuhlp-theme-toggle__track">
        <span className={`vuhlp-theme-toggle__thumb ${isLight ? 'vuhlp-theme-toggle__thumb--light' : ''}`}>
          {isLight ? (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="3.5" />
              <path d="M8 2v1M8 13v1M2 8h1M13 8h1M3.75 3.75l.75.75M11.5 11.5l.75.75M3.75 12.25l.75-.75M11.5 4.5l.75-.75" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13.5 10.5a5.5 5.5 0 01-8-8 5.5 5.5 0 108 8z" />
            </svg>
          )}
        </span>
      </span>
    </button>
  );
}
