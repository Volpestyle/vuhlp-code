import {
  createApiClient,
  getWebSocketUrl as getWsUrl,
} from '@vuhlp/shared';

// Configure this via environment or settings screen
const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export const api = createApiClient({ baseUrl: API_BASE });

export function getWebSocketUrl(runId: string): string {
  return getWsUrl(API_BASE, runId);
}
