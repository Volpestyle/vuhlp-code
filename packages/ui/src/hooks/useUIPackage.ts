import { useState, useCallback, useEffect } from 'react';

// UI package system for switching between UI themes
// Supports 'default' (original) and 'refresh' (technical minimal)

export type UIPackage = 'default' | 'refresh';

const UI_PACKAGE_STORAGE_KEY = 'vuhlp-ui-package';

const VALID_PACKAGES: UIPackage[] = ['default', 'refresh'];

function getStoredPackage(): UIPackage {
  if (typeof window === 'undefined') return 'default';
  const stored = localStorage.getItem(UI_PACKAGE_STORAGE_KEY);
  if (stored && VALID_PACKAGES.includes(stored as UIPackage)) {
    return stored as UIPackage;
  }
  return 'default';
}

export function useUIPackage(): [UIPackage, (pkg: UIPackage) => void] {
  const [uiPackage, setPackageState] = useState<UIPackage>(() => getStoredPackage());

  useEffect(() => {
    localStorage.setItem(UI_PACKAGE_STORAGE_KEY, uiPackage);
    // Could apply package-specific class to root element if needed
    document.documentElement.setAttribute('data-ui-package', uiPackage);
  }, [uiPackage]);

  const setUIPackage = useCallback((pkg: UIPackage) => {
    setPackageState(pkg);
  }, []);

  return [uiPackage, setUIPackage];
}

// Available UI packages
export const UI_PACKAGES: { id: UIPackage; label: string; description: string }[] = [
  { id: 'default', label: 'Default', description: 'Original vuhlp theme' },
  { id: 'refresh', label: 'Technical', description: 'Minimal monospace design' },
];
