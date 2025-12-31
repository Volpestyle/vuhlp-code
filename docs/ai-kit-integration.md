# Custom coding agent harness with ai-kit

This doc mirrors the integration surface expected by the harness and the real
`ai-kit` Go module (`github.com/Volpestyle/ai-kit/packages/go`).

## Harness flow
![Agent harness flow](diagrams/agent-harness.png)

## 1) Pick your integration surface
- **In-process (Go)**: embed the Kit directly for lowest latency.
- **HTTP API (Node/Go/Python)**: run ai-kit as a sidecar service and keep your
  harness language-agnostic.

## 2) Configure providers and initialize a Kit (Go)
```go
kit, err := aikit.New(aikit.Config{
  OpenAI:    &aikit.OpenAIConfig{APIKey: os.Getenv("OPENAI_API_KEY")},
  Anthropic: &aikit.AnthropicConfig{APIKey: os.Getenv("ANTHROPIC_API_KEY")},
  Google:    &aikit.GoogleConfig{APIKey: os.Getenv("GOOGLE_API_KEY")},
  Ollama:    &aikit.OllamaConfig{BaseURL: "http://localhost:11434"},
  RegistryTTL: 15 * time.Minute,
})
if err != nil {
  panic(err)
}
```

Notes:
- You can pass multiple API keys per provider; ai-kit will round-robin them.
- `RegistryTTL` controls how long model lists are cached before refresh.

## 3) Model swapping via a policy + router
Use the model registry to normalize provider metadata, then resolve a model
based on constraints (tools, vision, cost, preferred list). This keeps your
agent harness provider-agnostic.

```go
records, err := kit.ListModelRecords(ctx, nil)
if err != nil {
  panic(err)
}

router := &aikit.ModelRouter{}
resolved, err := router.Resolve(records, aikit.ModelResolutionRequest{
  Constraints: aikit.ModelConstraints{
    RequireTools:  true,
    RequireVision: true,
    MaxCostUSD:    5.00,
  },
  PreferredModels: []string{
    "openai:gpt-4o-mini",
    "anthropic:claude-3-5-sonnet",
  },
})
if err != nil {
  panic(err)
}

chosen := resolved.Primary
```

When you call the provider, use `ProviderModelID` from the resolved record:

```go
input := aikit.GenerateInput{
  Provider: chosen.Provider,
  Model:    chosen.ProviderModelID,
  Messages: []aikit.Message{{
    Role: "user",
    Content: []aikit.ContentPart{{
      Type: "text",
      Text: "Review this patch for correctness.",
    }},
  }},
}
out, err := kit.Generate(ctx, input)
```

If the chosen model fails, use `resolved.Fallback` for retries (it is an ordered slice).

## 4) Multimodal input
### Vision input in a single prompt
```go
visionInput := aikit.GenerateInput{
  Provider: chosen.Provider,
  Model:    chosen.ProviderModelID,
  Messages: []aikit.Message{{
    Role: "user",
    Content: []aikit.ContentPart{
      {Type: "text", Text: "What is unusual about this UI?"},
      {Type: "image", Image: &aikit.ImageContent{URL: "https://example.com/ui.png"}},
    },
  }},
}
out, err := kit.Generate(ctx, visionInput)
```

### Audio input via transcription
```go
transcript, err := kit.Transcribe(ctx, aikit.TranscribeInput{
  Provider: aikit.ProviderOpenAI,
  Model:    "whisper-1",
  Audio:    aikit.AudioInput{Path: "/tmp/agent-note.wav"},
})
```

## 5) Multimodal output
### Image generation
```go
imageOut, err := kit.GenerateImage(ctx, aikit.ImageGenerateInput{
  Provider: aikit.ProviderOpenAI,
  Model:    "<image-model-id>",
  Prompt:   "Blueprint-style diagram of the agent workflow.",
  Size:     "1024x1024",
})
```

If you need to discover image-capable models dynamically, use `ListModels` and
filter on `ModelMetadata.Capabilities`. Image/mesh generation is provider-
specific, so be ready to handle `ErrorUnsupported`.

## 6) Streaming + tool calls for agent loops
Streamed output is ideal for incremental UI updates or to start executing
tool calls before the model finishes.

```go
stream, err := kit.StreamGenerate(ctx, input)
for chunk := range stream {
  switch chunk.Type {
  case aikit.StreamChunkDelta:
    // Append chunk.TextDelta to the live response.
  case aikit.StreamChunkToolCall:
    // Execute chunk.Call and feed results back into the agent.
  }
}
```

## 7) Suggested harness flow
1. On startup, configure providers and cache model records.
2. For each task, resolve a model via `ModelRouter` + your policy.
3. Invoke `Generate`/`StreamGenerate` with text or vision content.
4. Branch to `GenerateImage`/`Transcribe` (and `GenerateMesh` if supported)
   for non-text work.
5. If a model fails, retry with `resolved.Fallback`.
