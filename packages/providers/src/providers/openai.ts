
import { randomUUID } from "node:crypto";
import type { ToolCall } from "@vuhlp/contracts";
import type { ToolExecutionResult } from "../tool-runner.js";
import type { ApiProviderConfig } from "../types.js";
import { normalizeBaseUrl, parseJsonArgs, safeJsonParse } from "../utils/common.js";
import { streamJsonLines } from "../utils/streaming.js";
import { openAiToolDefinitions } from "../utils/tools.js";
import type { ModelProvider, ModelProviderCallbacks, ModelResponse } from "./base.js";

type OpenAIToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

type OpenAIUsage = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
};

type OpenAIMessage =
    | { role: "system" | "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

export class OpenAIProvider implements ModelProvider {
    private history: OpenAIMessage[] = [];

    constructor(private readonly config: ApiProviderConfig) { }

    appendUserPrompt(prompt: string): void {
        this.history.push({ role: "user", content: prompt });
    }

    appendToolResult(tool: ToolCall, result: ToolExecutionResult): void {
        const payload = {
            ok: result.ok,
            output: result.output,
            error: result.error
        };
        this.history.push({
            role: "tool",
            tool_call_id: tool.id,
            content: JSON.stringify(payload)
        });
    }

    resetHistory(): void {
        this.history = [];
    }

    async call(callbacks: ModelProviderCallbacks): Promise<ModelResponse> {
        const url = `${normalizeBaseUrl(this.config.apiBaseUrl, "https://api.openai.com/v1")}/chat/completions`;

        const body: Record<string, unknown> = {
            model: this.config.model,
            messages: this.history,
            tools: openAiToolDefinitions(),
            tool_choice: "auto",
            stream: true,
            stream_options: { include_usage: true }
        };
        if (this.config.maxTokens) {
            body.max_tokens = this.config.maxTokens;
        }

        callbacks.debugLog(`OpenAI Request: POST ${url}`, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.config.apiKey.slice(0, 8)}...`
            },
            body
        });

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify(body)
        });

        callbacks.debugLog(`OpenAI Response: ${response.status} ${response.statusText}`, {
            headers: Object.fromEntries(response.headers.entries())
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`OpenAI request failed (${response.status}): ${text}`);
        }

        const toolCallsByIndex = new Map<number, { id: string; name: string; argsText: string }>();
        let text = "";
        type OpenAIPayload = {
            choices?: Array<{
                delta?: {
                    content?: string;
                    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
                };
                message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
            }>;
            usage?: OpenAIUsage;
        };

        let usagePromptTokens: number | null = null;
        let usageCompletionTokens: number | null = null;
        let usageTotalTokens: number | null = null;

        await streamJsonLines(response, (line) => {
            const data = line.startsWith("data:") ? line.slice(5).trimStart() : line;
            if (data === "[DONE]") {
                return;
            }
            const payload = safeJsonParse(data) as OpenAIPayload | null;
            if (!payload) {
                return;
            }
            if (payload.usage) {
                usagePromptTokens = payload.usage.prompt_tokens;
                usageCompletionTokens = payload.usage.completion_tokens;
                usageTotalTokens = payload.usage.total_tokens;
            }

            const delta = payload.choices?.[0]?.delta;
            if (!delta) {
                return;
            }
            if (typeof delta.content === "string") {
                text += delta.content;
                callbacks.onDelta(delta.content);
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const call of delta.tool_calls) {
                    const index = typeof call.index === "number" ? call.index : toolCallsByIndex.size;
                    const entry = toolCallsByIndex.get(index) ?? {
                        id: call.id ?? randomUUID(),
                        name: "",
                        argsText: ""
                    };
                    if (call.id) {
                        entry.id = call.id;
                    }
                    if (call.function?.name) {
                        entry.name = call.function.name;
                    }
                    if (call.function?.arguments) {
                        entry.argsText += call.function.arguments;
                    }
                    toolCallsByIndex.set(index, entry);
                }
            }
        });

        if (
            usagePromptTokens !== null &&
            usageCompletionTokens !== null &&
            usageTotalTokens !== null
        ) {
            callbacks.onUsage({
                promptTokens: usagePromptTokens,
                completionTokens: usageCompletionTokens,
                totalTokens: usageTotalTokens
            });
        }

        const ordered = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]);
        const toolCalls = ordered.map(([, call]) => ({
            id: call.id,
            name: call.name,
            args: parseJsonArgs(call.argsText)
        }));
        const openAiToolCalls: OpenAIToolCall[] = ordered.map(([, call]) => ({
            id: call.id,
            type: "function",
            function: {
                name: call.name,
                arguments: call.argsText
            }
        }));

        this.history.push({
            role: "assistant",
            content: text.length > 0 ? text : null,
            tool_calls: openAiToolCalls.length > 0 ? openAiToolCalls : undefined
        });

        return {
            text,
            toolCalls
        };
    }
}
