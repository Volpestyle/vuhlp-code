import * as Crypto from 'expo-crypto';

let warnedFallback = false;
let fallbackCounter = 0;

const buildFallbackUuid = (): string => {
  let timestamp = Date.now();
  let perf = 0;
  if (typeof globalThis.performance?.now === 'function') {
    perf = Math.floor(globalThis.performance.now() * 1000);
  }
  fallbackCounter = (fallbackCounter + 1) % 0x10000;
  let counter = fallbackCounter;

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    let random = Math.random() * 16;
    if (timestamp > 0) {
      random = (timestamp + random) % 16;
      timestamp = Math.floor(timestamp / 16);
    } else if (perf > 0) {
      random = (perf + random) % 16;
      perf = Math.floor(perf / 16);
    } else {
      random = (counter + random) % 16;
      counter = Math.floor(counter / 16);
    }

    const value = char === 'x' ? Math.floor(random) : (Math.floor(random) & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const createUuid = (): string => {
  try {
    return Crypto.randomUUID();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ids] expo-crypto randomUUID failed, trying web crypto', message);
  }

  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ids] web crypto randomUUID failed, using fallback', message);
  }

  if (!warnedFallback) {
    console.warn('[ids] randomUUID unavailable, using fallback generator');
    warnedFallback = true;
  }

  return buildFallbackUuid();
};

export const createLocalId = (prefix = 'local'): string => `${prefix}-${createUuid()}`;
