# Custom coding agent harness with ai-kit

This doc mirrors the integration surface expected by the harness and the real
`ai-kit` Node package (`@volpestyle/ai-kit-node`).

## Harness flow
![Agent harness flow](diagrams/agent-harness.png)

## 1) Pick your integration surface
- **In-process (Node/Bun)**: embed the Kit directly for lowest latency.
- **HTTP API (Node/Go/Python)**: run ai-kit as a sidecar service and keep your
  harness language-agnostic.

## 2) Configure providers and initialize a Kit (Node)
```ts
import { createKit, Provider } from "@volpestyle/ai-kit-node";

const kit = createKit({
  providers: {
    [Provider.OpenAI]: { apiKey: process.env.OPENAI_API_KEY },
    [Provider.Anthropic]: { apiKey: process.env.ANTHROPIC_API_KEY },
    [Provider.Google]: { apiKey: process.env.GOOGLE_API_KEY },
    [Provider.Ollama]: { baseURL: "http://localhost:11434" },
  },
  registry: { ttlMs: 15 * 60_000 },
});
```

Notes:
- You can pass multiple API keys per provider; ai-kit will round-robin them.
- `registry.ttlMs` controls how long model lists are cached before refresh.

## 3) Model swapping via a policy + router
Use the model registry to normalize provider metadata, then resolve a model
based on constraints (tools, vision, cost, preferred list). This keeps your
agent harness provider-agnostic.

```ts
import { ModelRouter } from "@volpestyle/ai-kit-node";

const records = await kit.listModelRecords();
const router = new ModelRouter();
const resolved = router.resolve(records, {
  constraints: {
    requireTools: true,
    requireVision: true,
    maxCostUsd: 5.0,
  },
  preferredModels: [
    "openai:gpt-4o-mini",
    "anthropic:claude-3-5-sonnet",
  ],
});

const chosen = resolved.primary;
```

When you call the provider, use `providerModelId` from the resolved record:

```ts
const out = await kit.generate({
  provider: chosen.provider,
  model: chosen.providerModelId,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Review this patch for correctness." }],
    },
  ],
});
```

If the chosen model fails, use `resolved.fallback` for retries (it is an ordered slice).

## 4) Multimodal input
### Vision input in a single prompt
```ts
const visionOut = await kit.generate({
  provider: chosen.provider,
  model: chosen.providerModelId,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is unusual about this UI?" },
        { type: "image", image: { url: "https://example.com/ui.png" } },
      ],
    },
  ],
});
```

### Audio input via transcription
```ts
const transcript = await kit.transcribe({
  provider: Provider.OpenAI,
  model: "whisper-1",
  audio: { path: "/tmp/agent-note.wav" },
});
```

## 5) Multimodal output
### Image generation
```ts
const imageOut = await kit.generateImage({
  provider: Provider.OpenAI,
  model: "<image-model-id>",
  prompt: "Blueprint-style diagram of the agent workflow.",
  size: "1024x1024",
});
```

If you need to discover image-capable models dynamically, use `listModels` and
filter on `ModelMetadata.capabilities`. Image/mesh generation is provider-
specific, so be ready to handle `ErrorUnsupported`.

## 6) Streaming + tool calls for agent loops
Streamed output is ideal for incremental UI updates or to start executing
tool calls before the model finishes.

```ts
const stream = kit.streamGenerate({
  provider: chosen.provider,
  model: chosen.providerModelId,
  messages: [{ role: "user", content: [{ type: "text", text: "Check this diff." }] }],
  tools: [/* tool definitions */],
  stream: true,
});

for await (const chunk of stream) {
  switch (chunk.type) {
    case "delta":
      // Append chunk.textDelta to the live response.
      break;
    case "tool_call":
      // Execute chunk.call and feed results back into the agent.
      break;
  }
}
```

## 7) Suggested harness flow
1. On startup, configure providers and cache model records.
2. For each task, resolve a model via `ModelRouter` + your policy.
3. Invoke `generate`/`streamGenerate` with text or vision content.
4. Branch to `generateImage`/`transcribe` (and `generateMesh` if supported)
   for non-text work.
5. If a model fails, retry with `resolved.fallback`.
