export { mapCodexEvent, isCodexEvent } from "./codexMapper.js";

export {
  mapClaudeEvent,
  isClaudeEvent,
  clearPendingTools as clearClaudePendingTools,
} from "./claudeMapper.js";

export {
  mapGeminiEvent,
  isGeminiEvent,
  clearPendingTools as clearGeminiPendingTools,
} from "./geminiMapper.js";

import { ProviderOutputEvent } from "../types.js";
import { mapCodexEvent, isCodexEvent } from "./codexMapper.js";
import { mapClaudeEvent, isClaudeEvent } from "./claudeMapper.js";
import { mapGeminiEvent, isGeminiEvent } from "./geminiMapper.js";

export type ProviderType = "codex" | "claude" | "gemini" | "unknown";

/**
 * Detect the provider type from a raw event.
 */
export function detectProvider(raw: unknown): ProviderType {
  if (isCodexEvent(raw)) return "codex";
  if (isClaudeEvent(raw)) return "claude";
  if (isGeminiEvent(raw)) return "gemini";
  return "unknown";
}

/**
 * Map a raw event to canonical ProviderOutputEvents using the appropriate mapper.
 */
export function* mapProviderEvent(
  raw: unknown,
  providerHint?: ProviderType
): Generator<ProviderOutputEvent> {
  const provider = providerHint ?? detectProvider(raw);

  switch (provider) {
    case "codex":
      yield* mapCodexEvent(raw);
      break;
    case "claude":
      yield* mapClaudeEvent(raw);
      break;
    case "gemini":
      yield* mapGeminiEvent(raw);
      break;
    default:
      // Unknown provider, yield raw as progress event
      yield {
        type: "progress",
        message: "[mapper] unknown event",
        raw,
      };
  }
}
