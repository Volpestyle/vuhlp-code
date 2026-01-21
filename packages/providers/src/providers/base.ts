
import type { ToolCall } from "@vuhlp/contracts";
import type { ToolExecutionResult } from "../tool-runner.js";
import type { ApiProviderConfig } from "../types.js";
import type { LogMeta } from "../logger.js";

export interface ModelResponse {
    text: string;
    toolCalls: ToolCall[];
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface ModelProviderCallbacks {
    onDelta: (delta: string) => void;
    onThinkingDelta: (delta: string) => void;
    onThinkingFinal: (content: string) => void;
    onUsage: (usage: TokenUsage) => void;
    debugLog: (message: string, meta?: LogMeta) => void;
}

export interface ModelProvider {
    call(callbacks: ModelProviderCallbacks): Promise<ModelResponse>;
    appendUserPrompt(prompt: string): void;
    appendToolResult(tool: ToolCall, result: ToolExecutionResult): void;
    resetHistory(): void;
}
