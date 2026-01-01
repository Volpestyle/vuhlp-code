import type { Kit, ModelRecord } from "@volpestyle/ai-kit-node";
import type { ModelPolicy } from "../config";
import { saveSettings } from "../config/settings";
import type { Runner } from "./runner";
import type { SessionRunner } from "./session_runner";

export class ModelService {
  private policy: ModelPolicy;

  constructor(
    private kit: Kit,
    policy: ModelPolicy,
    private settingsPath: string,
    private runner?: Runner,
    private sessionRunner?: SessionRunner,
  ) {
    this.policy = policy;
  }

  async listModels(): Promise<ModelRecord[]> {
    if (!this.kit) return [];
    return this.kit.listModelRecords();
  }

  getPolicy(): ModelPolicy {
    return this.policy;
  }

  async setPolicy(policy: ModelPolicy): Promise<void> {
    this.policy = policy;
    this.runner?.setPolicy(policy);
    this.sessionRunner?.setPolicy(policy);
    await saveSettings(this.settingsPath, { model_policy: policy });
  }
}
