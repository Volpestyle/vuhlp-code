import type { Logger } from "./logger.js";
import { CliProviderAdapter } from "./cli-adapter.js";
import { ApiProviderAdapter } from "./api-adapter.js";
import type { ProviderAdapter } from "./types.js";
import type { ProviderConfig } from "./types.js";

export function createProviderAdapter(config: ProviderConfig, logger?: Logger): ProviderAdapter {
  if (config.transport === "api") {
    return new ApiProviderAdapter(config, logger);
  }
  return new CliProviderAdapter(config, logger);
}
