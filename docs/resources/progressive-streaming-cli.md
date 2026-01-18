To get progressive/token streaming into a React web app and an Expo RN app, you want a setup like this:
	1.	Backend “proxy” service (Node/Go/etc) that runs the CLI (Claude Code / Codex CLI / Gemini CLI) in headless mode and streams stdout as events.
	2.	Frontends (web + Expo) connect to that backend via WebSocket and render deltas as they arrive.

Why: neither a browser nor RN can safely/portably spawn those CLIs; they need to run on a server (your laptop, a VM, a container, etc.), and you stream the output over the network.

Below is a practical, cross‑platform pattern that works well in Expo + Web using WebSockets.

⸻

1) Make each CLI emit newline-delimited JSON events

Claude Code (Anthropic)

Claude Code supports --output-format stream-json (newline-delimited JSON) and can include partial/token events with --include-partial-messages (requires --print and --output-format=stream-json).  ￼

Example:

claude -p --output-format stream-json --include-partial-messages "Say hello"

In practice, those partial events include deltas you can append (for example content_block_delta where event.delta.text is the next text fragment).  ￼

Gemini CLI (Google)

Gemini CLI supports --output-format stream-json for “real-time event streaming” as newline-delimited JSON events.  ￼
Real-world logs/issues show message events like:
{"type":"message","role":"assistant","content":"…","delta":true}  ￼

Example:

gemini -p "Say hello" --output-format stream-json

Codex CLI (OpenAI)

Codex non-interactive mode is codex exec. With --json, stdout becomes a JSON Lines (JSONL) stream of events; docs list event types and show sample lines including item.completed events with item.type:"agent_message" and item.text.  ￼

Example:

codex exec --json "Say hello"


⸻

2) Backend: one WebSocket endpoint that proxies CLI output

Use a WebSocket server that:
	•	Accepts an initial message with { provider, prompt }
	•	Spawns the chosen CLI in headless/JSON-stream mode
	•	Forwards each JSON line to the client as a WebSocket message

Node.js example (using `ws`):

import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import readline from "node:readline";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    // Expect initialization message
    const { provider, prompt } = JSON.parse(message.toString());
    
    const { cmd, args, stdinText } = buildCliCommand(provider, prompt);
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    // Cleanup on disconnect
    ws.on("close", () => child.kill());
    ws.on("error", () => child.kill());

    // Forward stderr
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "stderr", data: chunk }));
      }
    });

    // Write prompt
    if (stdinText) {
      child.stdin.write(stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    // Parse stdout
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (ws.readyState === ws.OPEN) {
        try {
          // Verify JSON before forwarding
          JSON.parse(trimmed); 
          ws.send(trimmed);
        } catch {
          ws.send(JSON.stringify({ type: "text", delta: trimmed + "\n" }));
        }
      }
    });

    child.on("close", (code, signal) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "done", code, signal }));
        ws.close();
      }
    });
  });
});

function buildCliCommand(provider: string, prompt: string) {
  switch (provider) {
    case "claude":
      return {
        cmd: "claude",
        args: ["-p", "--output-format", "stream-json", "--include-partial-messages", prompt],
        stdinText: null,
      };
    case "gemini":
      return {
        cmd: "gemini",
        args: ["-p", prompt, "--output-format", "stream-json"],
        stdinText: null,
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", "--json", "-"],
        stdinText: prompt,
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

app.listen(8787, () => console.log("Listening on http://localhost:8787"));

Notes that matter in production
	•	Do not expose this to untrusted users unless you sandbox hard. These CLIs can run tools, edit files, execute commands. Codex docs explicitly warn about permissions/sandbox choices (read-only by default; “danger-full-access” only in controlled environments).  ￼
	•	Put the CLI runner in a container with:
	•	limited filesystem
	•	no host network (or strict egress)
	•	CPU/memory/time limits
	•	an allowlist of tools/commands if possible

⸻

3) Client: WebSocket connection (works in Web + Expo)

Why this works well
WebSockets are standard in browsers and natively supported in React Native / Expo. They provide a simple event-based API.

⸻

4) React Web / Expo: shared hook

type StreamHandler = (evt: any) => void;

import { useEffect, useRef, useState, useCallback } from "react";

export function useStream(url: string, onEvent: StreamHandler) {
  const ws = useRef<WebSocket | null>(null);

  const connect = useCallback((body: any) => {
    if (ws.current) ws.current.close();
    
    // In Expo, you might need to use your machine's IP instead of localhost
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify(body));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
      } catch (e) {
        console.error("Failed to parse event", e);
      }
    };

    socket.onerror = (e) => {
      console.error("WebSocket error", e);
    };
  }, [url, onEvent]);

  const close = useCallback(() => {
    ws.current?.close();
  }, []);

  useEffect(() => {
    return () => {
      ws.current?.close();
    };
  }, []);

  return { connect, close };
}


⸻

6) Mapping events to “append text progressively”

You’ll typically keep a single “currently streaming assistant message” and append deltas.

Here are reliable extraction patterns:

Claude Code stream-json (with partial messages)
	•	Look for events where a text delta exists (commonly event.delta.text in a content_block_delta flow).  ￼
	•	Pseudocode:

function extractClaudeDelta(evt: any): string | null {
  // Common pattern seen in stream-json output:
  // { type:"stream_event", event:{ type:"content_block_delta", delta:{ type:"text_delta", text:"..." } } }
  const t = evt?.event?.delta?.text;
  return typeof t === "string" ? t : null;
}

Gemini CLI stream-json
	•	type:"message", role:"assistant", delta:true → append content  ￼

function extractGeminiDelta(evt: any): string | null {
  if (evt?.type === "message" && evt?.role === "assistant") {
    if (evt?.delta === true && typeof evt?.content === "string") return evt.content;
    // some events may be full snapshots (delta omitted/false)
    if (evt?.delta !== true && typeof evt?.content === "string") return evt.content;
  }
  return null;
}

Codex CLI JSONL
	•	Watch for item.* events; when you get an item.completed with item.type:"agent_message", the text is in item.text.  ￼

function extractCodexText(evt: any): string | null {
  if (evt?.type === "item.completed" && evt?.item?.type === "agent_message") {
    const t = evt?.item?.text;
    return typeof t === "string" ? t : null;
  }
  return null;
}


⸻

7) A cross-platform React hook that throttles UI updates

Updating state on every token can cause jank. Buffer deltas in a ref and flush on an interval / animation frame.

import { useRef, useState, useCallback } from "react";

export function useStreamingText() {
  const [text, setText] = useState("");
  const bufferRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const append = useCallback((delta: string) => {
    bufferRef.current += delta;

    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const chunk = bufferRef.current;
      bufferRef.current = "";
      setText((t) => t + chunk);
    });
  }, []);

  const reset = useCallback(() => {
    bufferRef.current = "";
    setText("");
  }, []);

  return { text, append, reset };
}

In RN, requestAnimationFrame exists too; if you prefer, flush every ~50ms with setInterval instead.

⸻

8) Putting it together (Web component example)

function Chat() {
  const { text, append, reset } = useStreamingText();
  const [loading, setLoading] = useState(false);

  // Memoize event handler
  const handleEvent = useCallback((evt: any) => {
        const delta =
          extractClaudeDelta(evt) ??
          extractGeminiDelta(evt) ??
          extractCodexText(evt);

        if (delta) append(delta);
        if (evt.type === "done") setLoading(false);
  }, [append]);

  const { connect } = useStream("ws://localhost:8080", handleEvent);

  function run(provider: "claude"|"gemini"|"codex", prompt: string) {
    reset();
    setLoading(true);
    connect({ provider, prompt });
  }

  return (
    <div>
      <button onClick={() => run("claude", "Write a haiku about codecs")}>Claude</button>
      <button onClick={() => run("gemini", "Write a haiku about codecs")}>Gemini</button>
      <button onClick={() => run("codex", "Write a haiku about codecs")}>Codex</button>

      {loading ? <p>Streaming…</p> : null}
      <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
    </div>
  );
}


⸻

9) Expo-specific gotchas
	•	If your backend is on your dev machine:
	•	Android emulator can’t reach localhost as itself; you often need 10.0.2.2 (emulator) or your LAN IP (device).
	•	Prefer HTTPS + auth in real deployments.

⸻

10) Alternatives (when you might pick them)
	•	HTTP Streaming (NDJSON)
	Good for simple one-way streams. Requires `fetch` with readable streams support (now standard, but can be tricky in some React Native environments).
	•	Server-Sent Events (SSE)
	Great for browsers (EventSource), but Expo/RN needs polyfills or manual parsing. WebSockets tend to be more robust for bidirectional needs.

⸻

If you tell me which backend you’re using (Express, Next.js route handler, Cloudflare Workers, Fastify, etc.) and whether you need multi-turn sessions (continue/resume), I can adapt the server endpoint shape and the event-to-UI mapping more precisely.