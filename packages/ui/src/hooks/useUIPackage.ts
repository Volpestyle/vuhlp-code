import { useState, useCallback, useEffect } from 'react';

// UI package system for potential future theme packs
// Currently we only have one package, but this allows for extensibility

export type UIPackage = 'default';

const UI_PACKAGE_STORAGE_KEY = 'vuhlp-ui-package';

function getStoredPackage(): UIPackage {
  if (typeof window === 'undefined') return 'default';
  const stored = localStorage.getItem(UI_PACKAGE_STORAGE_KEY);
  if (stored === 'default') {
    return stored;
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
export const UI_PACKAGES: { id: UIPackage; label: string }[] = [
  { id: 'default', label: 'Default' },
];
