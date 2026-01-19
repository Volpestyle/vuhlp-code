import { AsciiSpinner } from './AsciiSpinner';

interface PageLoaderProps {
  error?: string | null;
  onRetry?: () => void;
  size?: number;
}

export function PageLoader({ error, onRetry, size = 300 }: PageLoaderProps) {
  return (
    <div className="app__loader">
      <div className="app__loader-content">
        <AsciiSpinner size={size} cycle />
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
