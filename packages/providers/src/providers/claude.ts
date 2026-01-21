
import { randomUUID } from "node:crypto";
import type { ToolCall } from "@vuhlp/contracts";
import type { ToolExecutionResult } from "../tool-runner.js";
import type { ApiProviderConfig } from "../types.js";
import { normalizeBaseUrl, parseJsonArgs, safeJsonParse } from "../utils/common.js";
import { streamSse } from "../utils/streaming.js";
import { claudeToolDefinitions } from "../utils/tools.js";
import type { ModelProvider, ModelProviderCallbacks, ModelResponse } from "./base.js";

type ClaudeContentBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type ClaudeMessage = {
    role: "user" | "assistant";
    content: ClaudeContentBlock[];
};

export class ClaudeProvider implements ModelProvider {
    private history: ClaudeMessage[] = [];

    constructor(private readonly config: ApiProviderConfig) { }

    appendUserPrompt(prompt: string): void {
        this.history.push({ role: "user", content: [{ type: "text", text: prompt }] });
    }

    appendToolResult(tool: ToolCall, result: ToolExecutionResult): void {
        const payload = {
            ok: result.ok,
            output: result.output,
            error: result.error
        };
        this.history.push({
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: tool.id,
                    content: JSON.stringify(payload),
                    is_error: !result.ok
                }
            ]
        });
    }

    resetHistory(): void {
        this.history = [];
    }

    async call(callbacks: ModelProviderCallbacks): Promise<ModelResponse> {
        const url = `${normalizeBaseUrl(this.config.apiBaseUrl, "https://api.anthropic.com")}/v1/messages`;

        const body: Record<string, unknown> = {
            model: this.config.model,
            max_tokens: this.config.maxTokens ?? 2048,
            messages: this.history,
            tools: claudeToolDefinitions(),
            stream: true
        };

        callbacks.debugLog(`Claude Request: POST ${url}`, {
            headers: {
                "Content-Type": "application/json",
                "x-api-key": `${this.config.apiKey.slice(0, 8)}...`,
                "anthropic-version": "2023-06-01"
            },
            body
        });

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.config.apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify(body)
        });

        callbacks.debugLog(`Claude Response: ${response.status} ${response.statusText}`, {
            headers: Object.fromEntries(response.headers.entries())
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Claude request failed (${response.status}): ${text}`);
        }

        const blocks = new Map<
            number,
            { type: "text" | "thinking" | "tool_use"; id?: string; name?: string; inputJson: string; thinkingText?: string }
        >();
        let text = "";
        let thinkingText = "";
        let inputTokens = 0;
        let outputTokens = 0;

        await streamSse(response, (data) => {
            const payload = safeJsonParse(data) as
                | {
                    type?: string;
                    index?: number;
                    content_block?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> };
                    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
                    usage?: { input_tokens?: number; output_tokens?: number };
                    message?: { usage?: { input_tokens?: number; output_tokens?: number } };
                }
                | null;
            if (!payload?.type) {
                return;
            }
            switch (payload.type) {
                case "message_start": {
                    if (payload.message?.usage) {
                        inputTokens += payload.message.usage.input_tokens ?? 0;
                    }
                    break;
                }
                case "message_stop": {
                    break;
                }
                case "message_delta": {
                    if (payload.usage) {
                        outputTokens = payload.usage.output_tokens ?? outputTokens;
                    }
                    break;
                }
                case "content_block_start": {
                    const index = typeof payload.index === "number" ? payload.index : blocks.size;
                    const contentBlock = payload.content_block;
                    if (contentBlock?.type === "text") {
                        const initial = typeof contentBlock.text === "string" ? contentBlock.text : "";
                        if (initial) {
                            text += initial;
                            callbacks.onDelta(initial);
                        }
                        blocks.set(index, { type: "text", inputJson: "" });
                    } else if (contentBlock?.type === "thinking") {
                        const initial = typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
                        if (initial) {
                            thinkingText += initial;
                            callbacks.onThinkingDelta(initial);
                        }
                        blocks.set(index, { type: "thinking", inputJson: "", thinkingText: initial });
                    } else if (contentBlock?.type === "tool_use") {
                        const input = contentBlock.input ?? {};
                        const inputJson = Object.keys(input).length > 0 ? JSON.stringify(input) : "";
                        blocks.set(index, {
                            type: "tool_use",
                            id: contentBlock.id,
                            name: contentBlock.name,
                            inputJson
                        });
                    }
                    break;
                }
                case "content_block_delta": {
                    const index = typeof payload.index === "number" ? payload.index : -1;
                    const delta = payload.delta;
                    if (!delta) {
                        break;
                    }
                    if (delta.type === "text_delta" && typeof delta.text === "string") {
                        text += delta.text;
                        callbacks.onDelta(delta.text);
                    }
                    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                        thinkingText += delta.thinking;
                        callbacks.onThinkingDelta(delta.thinking);
                        const entry = blocks.get(index);
                        if (entry && entry.type === "thinking") {
                            entry.thinkingText = (entry.thinkingText ?? "") + delta.thinking;
                        }
                    }
                    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                        const entry = blocks.get(index);
                        if (entry) {
                            const trimmed = entry.inputJson.trim();
                            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                                entry.inputJson = "";
                            }
                            entry.inputJson += delta.partial_json;
                        } else {
                            blocks.set(index, { type: "tool_use", inputJson: delta.partial_json });
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        });

        // Emit thinking.final if we accumulated thinking content
        if (thinkingText.length > 0) {
            callbacks.onThinkingFinal(thinkingText);
        }

        if (inputTokens > 0 || outputTokens > 0) {
            callbacks.onUsage({
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens
            });
        }

        const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
        const toolCalls = ordered
            .filter(([, block]) => block.type === "tool_use")
            .map(([, block]) => ({
                id: block.id ?? randomUUID(),
                name: block.name ?? "tool",
                args: parseJsonArgs(block.inputJson)
            }));

        const assistantBlocks: ClaudeContentBlock[] = [];
        if (thinkingText.length > 0) {
            assistantBlocks.push({ type: "thinking", thinking: thinkingText });
        }
        if (text.length > 0) {
            assistantBlocks.push({ type: "text", text });
        }
        for (const toolCall of toolCalls) {
            assistantBlocks.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.args });
        }

        this.history.push({ role: "assistant", content: assistantBlocks });

        return { text, toolCalls };
    }
}
