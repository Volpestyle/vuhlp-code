/**
 * Provider badge component for displaying CLI provider
 */

import type { ProviderName } from '@vuhlp/contracts';
import './ProviderBadge.css';

interface ProviderBadgeProps {
  provider: ProviderName;
  size?: 'sm' | 'md';
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  custom: 'Custom',
};

export function ProviderBadge({ provider, size = 'md' }: ProviderBadgeProps) {
  return (
    <span className={`provider-badge provider-badge--${provider} provider-badge--${size}`}>
      {PROVIDER_LABELS[provider]}
    </span>
  );
}
