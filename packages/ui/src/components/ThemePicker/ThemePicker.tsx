import { useState, useRef, useEffect } from 'react';
import { useTheme, THEMES, type Theme } from '../../hooks/useTheme';
import { UI_PACKAGES, type UIPackage } from '../../hooks/useUIPackage';
import './ThemePicker.css';

export interface ThemePickerProps {
  currentPackage: UIPackage;
  onPackageChange: (pkg: UIPackage) => void;
  className?: string;
}

export function ThemePicker({ currentPackage, onPackageChange, className = '' }: ThemePickerProps) {
  const [theme, setTheme] = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentUiPackage = UI_PACKAGES.find((p) => p.id === currentPackage);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const currentTheme = THEMES.find((t) => t.id === theme);

  return (
    <div ref={containerRef} className={`vuhlp-theme-picker ${className}`}>
      <button
        className="vuhlp-theme-picker__trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" strokeLinecap="round" />
        </svg>
        <span>{currentUiPackage?.label || 'Default'} / {currentTheme?.label || 'Theme'}</span>
        <svg className="vuhlp-theme-picker__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen && (
        <div className="vuhlp-theme-picker__dropdown" role="listbox">
          <div className="vuhlp-theme-picker__section">
            <div className="vuhlp-theme-picker__section-title">UI Style</div>
            {UI_PACKAGES.map((pkg) => (
              <button
                key={pkg.id}
                className={`vuhlp-theme-picker__option ${currentPackage === pkg.id ? 'vuhlp-theme-picker__option--active' : ''}`}
                onClick={() => {
                  onPackageChange(pkg.id);
                }}
                role="option"
                aria-selected={currentPackage === pkg.id}
              >
                <span className="vuhlp-theme-picker__option-label">{pkg.label}</span>
                <span className="vuhlp-theme-picker__option-desc">{pkg.description}</span>
                {currentPackage === pkg.id && (
                  <svg className="vuhlp-theme-picker__check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          <div className="vuhlp-theme-picker__section">
            <div className="vuhlp-theme-picker__section-title">Color Theme</div>
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`vuhlp-theme-picker__option ${theme === t.id ? 'vuhlp-theme-picker__option--active' : ''}`}
                onClick={() => {
                  setTheme(t.id as Theme);
                }}
                role="option"
                aria-selected={theme === t.id}
              >
                <span className="vuhlp-theme-picker__option-label">{t.label}</span>
                <span className="vuhlp-theme-picker__option-desc">{t.description}</span>
                {theme === t.id && (
                  <svg className="vuhlp-theme-picker__check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
