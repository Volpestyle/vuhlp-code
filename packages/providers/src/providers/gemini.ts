
import { randomUUID } from "node:crypto";
import type { ToolCall } from "@vuhlp/contracts";
import type { ToolExecutionResult } from "../tool-runner.js";
import type { ApiProviderConfig } from "../types.js";
import { normalizeBaseUrl, safeJsonParse } from "../utils/common.js";
import { streamSse } from "../utils/streaming.js";
import { geminiToolDefinitions } from "../utils/tools.js";
import type { ModelProvider, ModelProviderCallbacks, ModelResponse } from "./base.js";

type GeminiPart =
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiUsageMetadata = {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
};

type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};

export class GeminiProvider implements ModelProvider {
    private history: GeminiContent[] = [];

    constructor(private readonly config: ApiProviderConfig) { }

    appendUserPrompt(prompt: string): void {
        this.history.push({ role: "user", parts: [{ text: prompt }] });
    }

    appendToolResult(tool: ToolCall, result: ToolExecutionResult): void {
        const payload = {
            ok: result.ok,
            output: result.output,
            error: result.error
        };
        this.history.push({
            role: "user",
            parts: [
                {
                    functionResponse: {
                        name: tool.name,
                        response: payload
                    }
                }
            ]
        });
    }

    resetHistory(): void {
        this.history = [];
    }

    async call(callbacks: ModelProviderCallbacks): Promise<ModelResponse> {
        const base = normalizeBaseUrl(this.config.apiBaseUrl, "https://generativelanguage.googleapis.com/v1beta");
        const url = `${base}/models/${this.config.model}:streamGenerateContent?key=${encodeURIComponent(
            this.config.apiKey
        )}`;

        const body: Record<string, unknown> = {
            contents: this.history,
            tools: [
                {
                    functionDeclarations: geminiToolDefinitions()
                }
            ],
            toolConfig: {
                functionCallingConfig: {
                    mode: "AUTO"
                }
            }
        };

        if (this.config.maxTokens) {
            body.generationConfig = {
                maxOutputTokens: this.config.maxTokens
            };
        }

        callbacks.debugLog(`Gemini Request: POST ${url.replace(this.config.apiKey, "KEY_HIDDEN")}`, {
            headers: {
                "Content-Type": "application/json"
            },
            body
        });

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        callbacks.debugLog(`Gemini Response: ${response.status} ${response.statusText}`, {
            headers: Object.fromEntries(response.headers.entries())
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Gemini request failed (${response.status}): ${text}`);
        }

        const parts: GeminiPart[] = [];
        const toolCalls: ToolCall[] = [];
        let text = "";
        let usageMetadata: GeminiUsageMetadata | null = null;

        await streamSse(response, (data) => {
            if (data === "[DONE]") {
                return;
            }
            const payload = safeJsonParse(data) as
                | {
                    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
                    usageMetadata?: GeminiUsageMetadata;
                }
                | null;
            if (!payload) {
                return;
            }
            if (payload.usageMetadata) {
                usageMetadata = payload.usageMetadata;
            }
            const candidateParts = payload.candidates?.[0]?.content?.parts ?? [];
            for (const part of candidateParts) {
                if ("text" in part && typeof part.text === "string") {
                    text += part.text;
                    callbacks.onDelta(part.text);
                    const last = parts[parts.length - 1];
                    if (last && "text" in last) {
                        last.text += part.text;
                    } else {
                        parts.push({ text: part.text });
                    }
                } else if ("functionCall" in part) {
                    const call = (part as Extract<GeminiPart, { functionCall: { name: string; args: Record<string, unknown> } }>).
                        functionCall;
                    const args = typeof call.args === "object" && call.args ? call.args : { _raw: call.args };
                    toolCalls.push({
                        id: randomUUID(),
                        name: call.name,
                        args
                    });
                    parts.push({ functionCall: { name: call.name, args } });
                }
            }
        });

        this.history.push({ role: "model", parts });

        const usage = usageMetadata as GeminiUsageMetadata | null;
        if (usage) {
            const promptTokens =
                usage.promptTokenCount ??
                (usage.totalTokenCount !== undefined && usage.candidatesTokenCount !== undefined
                    ? Math.max(usage.totalTokenCount - usage.candidatesTokenCount, 0)
                    : 0);
            const completionTokens =
                usage.candidatesTokenCount ??
                (usage.totalTokenCount !== undefined
                    ? Math.max(usage.totalTokenCount - promptTokens, 0)
                    : 0);
            const totalTokens = usage.totalTokenCount ?? promptTokens + completionTokens;
            if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
                callbacks.onUsage({
                    promptTokens,
                    completionTokens,
                    totalTokens
                });
            }
        }

        return { text, toolCalls };
    }
}
