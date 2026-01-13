import { describe, it, expect, beforeEach } from "vitest";
import { mapGeminiEvent, isGeminiEvent, clearPendingTools } from "../geminiMapper.js";

describe("geminiMapper", () => {
  beforeEach(() => {
    clearPendingTools();
  });

  describe("isGeminiEvent", () => {
    it("returns true for valid Gemini event types", () => {
      expect(isGeminiEvent({ type: "init" })).toBe(true);
      expect(isGeminiEvent({ type: "message" })).toBe(true);
      expect(isGeminiEvent({ type: "tool_use" })).toBe(true);
      expect(isGeminiEvent({ type: "tool_result" })).toBe(true);
      expect(isGeminiEvent({ type: "result" })).toBe(true);
      expect(isGeminiEvent({ type: "error" })).toBe(true);
      expect(isGeminiEvent({ type: "thinking" })).toBe(true);
      expect(isGeminiEvent({ type: "delta" })).toBe(true);
    });

    it("returns false for invalid events", () => {
      expect(isGeminiEvent(null)).toBe(false);
      expect(isGeminiEvent(undefined)).toBe(false);
      expect(isGeminiEvent("string")).toBe(false);
      expect(isGeminiEvent({ type: "unknown" })).toBe(false);
    });
  });

  describe("mapGeminiEvent", () => {
    it("maps init event to session event", () => {
      const events = Array.from(
        mapGeminiEvent({ type: "init", session_id: "gemini-sess-123" })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "session", sessionId: "gemini-sess-123" });
    });

    it("maps delta event to message.delta", () => {
      const events = Array.from(
        mapGeminiEvent({ type: "delta", content: "Hello " })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.delta",
        delta: "Hello ",
        index: undefined,
      });
    });

    it("maps thinking event to message.reasoning", () => {
      const events = Array.from(
        mapGeminiEvent({ type: "thinking", content: "Analyzing the request..." })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.reasoning",
        content: "Analyzing the request...",
      });
    });

    it("maps message event with model role to message.final", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "message",
          role: "model",
          content: "Hello from Gemini",
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.final",
        content: "Hello from Gemini",
      });
    });

    it("maps message event with parts", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "message",
          role: "model",
          parts: [
            { type: "text", text: "Here's some code:" },
            { type: "code", code: "console.log('hi')", language: "javascript" },
          ],
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "message.final",
        content: "Here's some code:\n```javascript\nconsole.log('hi')\n```\n",
      });
    });

    it("maps message event with execution_result part to json event", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "message",
          role: "model",
          parts: [{ type: "execution_result", output: "Command output here" }],
        })
      );
      const jsonEvent = events.find((e) => e.type === "json");
      expect(jsonEvent).toMatchObject({
        type: "json",
        name: "execution_result.json",
        json: { output: "Command output here" },
      });
    });

    it("ignores message events with non-model role", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "message",
          role: "user",
          content: "User message",
        })
      );
      expect(events).toHaveLength(0);
    });

    it("maps tool_use event to tool.proposed and tool.started", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "tool_use",
          id: "gemini-tool-1",
          name: "read_file",
          args: { path: "/test.txt" },
        })
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "tool.proposed",
        tool: {
          id: "gemini-tool-1",
          name: "read_file",
          args: { path: "/test.txt" },
          riskLevel: "low",
        },
      });
      expect(events[1]).toEqual({ type: "tool.started", toolId: "gemini-tool-1" });
    });

    it("maps tool_result success to tool.completed", () => {
      // Register the tool first
      Array.from(
        mapGeminiEvent({ type: "tool_use", id: "gt-2", name: "read_file", args: {} })
      );

      const events = Array.from(
        mapGeminiEvent({
          type: "tool_result",
          id: "gt-2",
          output: "file contents",
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool.completed",
        toolId: "gt-2",
        result: "file contents",
      });
    });

    it("maps tool_result with error to tool.completed with error", () => {
      Array.from(
        mapGeminiEvent({ type: "tool_use", id: "gt-3", name: "read_file", args: {} })
      );

      const events = Array.from(
        mapGeminiEvent({
          type: "tool_result",
          id: "gt-3",
          error: "File not found",
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool.completed",
        toolId: "gt-3",
        error: { message: "File not found" },
      });
    });

    it("parses JSON output in tool_result", () => {
      Array.from(
        mapGeminiEvent({ type: "tool_use", id: "gt-4", name: "list_files", args: {} })
      );

      const events = Array.from(
        mapGeminiEvent({
          type: "tool_result",
          id: "gt-4",
          output: '{"files": ["a.txt", "b.txt"]}',
        })
      );
      expect(events[0]).toMatchObject({
        type: "tool.completed",
        toolId: "gt-4",
        result: { files: ["a.txt", "b.txt"] },
      });
    });

    it("maps result event with reasoning_summary", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "result",
          session_id: "sess-123",
          reasoning_summary: "Summary of reasoning",
          token_stats: { input: 100, output: 50 },
        })
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "message.reasoning",
        content: "Summary of reasoning",
      });
      expect(events[1]).toMatchObject({
        type: "json",
        name: "session_result.json",
        json: {
          session_id: "sess-123",
          token_stats: { input: 100, output: 50 },
        },
      });
    });

    it("maps error event to progress event", () => {
      const events = Array.from(
        mapGeminiEvent({
          type: "error",
          message: "Rate limit reached",
          code: "RATE_LIMIT",
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "progress",
        message: "[gemini] error: Rate limit reached",
        raw: { message: "Rate limit reached", code: "RATE_LIMIT" },
      });
    });

    it("assigns correct risk levels to tools", () => {
      // Low risk: read_file
      const readEvents = Array.from(
        mapGeminiEvent({ type: "tool_use", id: "t1", name: "read_file", args: {} })
      );
      expect(readEvents[0]).toMatchObject({
        tool: { riskLevel: "low" },
      });

      clearPendingTools();

      // Medium risk: write_file
      const writeEvents = Array.from(
        mapGeminiEvent({ type: "tool_use", id: "t2", name: "write_file", args: {} })
      );
      expect(writeEvents[0]).toMatchObject({
        tool: { riskLevel: "medium" },
      });

      clearPendingTools();

      // High risk: execute_command with rm
      const rmEvents = Array.from(
        mapGeminiEvent({
          type: "tool_use",
          id: "t3",
          name: "execute_command",
          args: { command: "rm -rf /tmp" },
        })
      );
      expect(rmEvents[0]).toMatchObject({
        tool: { riskLevel: "high" },
      });
    });

    it("returns empty array for invalid input", () => {
      expect(Array.from(mapGeminiEvent(null))).toEqual([]);
      expect(Array.from(mapGeminiEvent(undefined))).toEqual([]);
      expect(Array.from(mapGeminiEvent("string"))).toEqual([]);
    });
  });
});
