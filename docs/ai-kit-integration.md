# Custom coding agent harness with ai-kit

This doc mirrors the integration surface expected by the harness and the real
`ai-kit` Python packages (`ai-kit` + `ai-kit-inference`).

## Harness flow
![Agent harness flow](diagrams/agent-harness.png)

## 1) Pick your integration surface
- **In-process (Python)**: embed the Kit directly for lowest latency.
- **HTTP API (Python/Go/Node)**: run ai-kit as a sidecar service and keep your
  harness language-agnostic.

## 2) Configure providers and initialize a Kit (Python)
```py
import os
from ai_kit import Kit, KitConfig
from ai_kit.providers import OpenAIConfig, AnthropicConfig, GeminiConfig, OllamaConfig

kit = Kit(
    KitConfig(
        providers={
            "openai": OpenAIConfig(api_key=os.environ.get("OPENAI_API_KEY", "")),
            "anthropic": AnthropicConfig(api_key=os.environ.get("ANTHROPIC_API_KEY", "")),
            "google": GeminiConfig(api_key=os.environ.get("GOOGLE_API_KEY", "")),
            "ollama": OllamaConfig(base_url="http://localhost:11434"),
        },
        registry_ttl_seconds=15 * 60,
    )
)
```

Notes:
- You can pass multiple API keys per provider; ai-kit will round-robin them.
- `registry_ttl_seconds` controls how long model lists are cached before refresh.

## 3) Model swapping via a policy + router
Use the model registry to normalize provider metadata, then resolve a model
based on constraints (tools, vision, cost, preferred list). This keeps your
agent harness provider-agnostic.

```py
from ai_kit import ModelRouter, ModelConstraints, ModelResolutionRequest

records = kit.list_model_records()
router = ModelRouter()
resolved = router.resolve(
    records,
    ModelResolutionRequest(
        constraints=ModelConstraints(
            requireTools=True,
            requireVision=True,
            maxCostUsd=5.0,
        ),
        preferredModels=[
            "openai:gpt-4o-mini",
            "anthropic:claude-3-5-sonnet",
        ],
    ),
)

chosen = resolved.primary
```

When you call the provider, use `providerModelId` from the resolved record:

```py
from ai_kit import GenerateInput, Message, ContentPart

out = kit.generate(
    GenerateInput(
        provider=chosen.provider,
        model=chosen.providerModelId,
        messages=[Message(role="user", content=[ContentPart(type="text", text="Review this patch.")])],
    )
)
```

If the chosen model fails, use `resolved.fallback` for retries (it is an ordered slice).

## 4) Multimodal input
### Vision input in a single prompt
```py
from ai_kit import GenerateInput, Message, ContentPart

vision_out = kit.generate(
    GenerateInput(
        provider=chosen.provider,
        model=chosen.providerModelId,
        messages=[
            Message(
                role="user",
                content=[
                    ContentPart(type="text", text="What is unusual about this UI?"),
                    ContentPart(type="image", image={"url": "https://example.com/ui.png"}),
                ],
            )
        ],
    )
)
```

### Audio input via transcription
```py
from ai_kit import TranscribeInput, AudioInput

transcript = kit.transcribe(
    TranscribeInput(
        provider="openai",
        model="whisper-1",
        audio=AudioInput(path="/tmp/agent-note.wav"),
    )
)
```

## 5) Multimodal output
### Image generation
```py
from ai_kit import ImageGenerateInput

image_out = kit.generate_image(
    ImageGenerateInput(
        provider="openai",
        model="<image-model-id>",
        prompt="Blueprint-style diagram of the agent workflow.",
        size="1024x1024",
    )
)
```

If you need to discover image-capable models dynamically, use `listModels` and
filter on `ModelMetadata.capabilities`. Image/mesh generation is provider-
specific, so be ready to handle `ErrorUnsupported`.

## 6) Tool calls for agent loops (Python)
The Python Kit currently exposes `generate` (no streaming). Tool calls are
returned in the output payload and can be executed in your agent loop.

```py
from ai_kit import GenerateInput, Message, ContentPart

out = kit.generate(
    GenerateInput(
        provider=chosen.provider,
        model=chosen.providerModelId,
        messages=[Message(role="user", content=[ContentPart(type="text", text="Check this diff.")])],
        tools=[/* tool definitions */],
    )
)

for call in out.toolCalls or []:
    # Execute call and feed results back into the agent.
    pass
```

If you need streaming, use the HTTP sidecar option and stream responses from
that service.

## 7) Suggested harness flow
1. On startup, configure providers and cache model records.
2. For each task, resolve a model via `ModelRouter` + your policy.
3. Invoke `generate` with text or vision content (streaming via the HTTP sidecar if needed).
4. Branch to `generateImage`/`transcribe` (and `generateMesh` if supported)
   for non-text work.
5. If a model fails, retry with `resolved.fallback`.
