import {
  createApiClient,
  getWebSocketUrl as getWsUrl,
} from '@vuhlp/shared';

// Production: set EXPO_PUBLIC_API_URL (e.g., https://api.vuhlp.com)
// Development: derives from REACT_NATIVE_PACKAGER_HOSTNAME
const API_BASE = process.env.EXPO_PUBLIC_API_URL
  ?? (process.env.REACT_NATIVE_PACKAGER_HOSTNAME
      ? `http://${process.env.REACT_NATIVE_PACKAGER_HOSTNAME}:4000`
      : 'http://localhost:4000');

console.log('[api] API_BASE:', API_BASE);

export const api = createApiClient({ baseUrl: API_BASE });

export function getWebSocketUrl(runId: string): string {
  return getWsUrl(API_BASE, runId);
}
