import { ThinkingSpinner } from '@vuhlp/spinners';

interface PageLoaderProps {
  error?: string | null;
  onRetry?: () => void;
  size?: 'sm' | 'lg';
}

export function PageLoader({ error, onRetry, size = 'lg' }: PageLoaderProps) {
  return (
    <div className="app__loader">
      <div className="app__loader-content">
        <div className="app__loader-spinner" aria-hidden="true">
          <ThinkingSpinner size={size} variant="assemble" color="var(--color-text-accent)" />
        </div>
        {error ? (
          <div className="app__loader-error" role="alert">
            <div className="app__loader-title">Unable to load session</div>
            <div className="app__loader-detail">{error}</div>
            {onRetry ? (
              <button className="app__loader-action" type="button" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
