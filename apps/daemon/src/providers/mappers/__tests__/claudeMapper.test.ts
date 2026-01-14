import { describe, it, expect, beforeEach } from "vitest";
import { mapClaudeEvent, isClaudeEvent, clearPendingTools } from "../claudeMapper.js";

describe("claudeMapper", () => {
  beforeEach(() => {
    clearPendingTools();
  });

  describe("isClaudeEvent", () => {
    it("returns true for valid Claude event types", () => {
      expect(isClaudeEvent({ type: "init" })).toBe(true);
      expect(isClaudeEvent({ type: "assistant" })).toBe(true);
      expect(isClaudeEvent({ type: "assistant_partial" })).toBe(true);
      expect(isClaudeEvent({ type: "tool_use" })).toBe(true);
      expect(isClaudeEvent({ type: "tool_result" })).toBe(true);
      expect(isClaudeEvent({ type: "result" })).toBe(true);
      expect(isClaudeEvent({ type: "error" })).toBe(true);
      expect(isClaudeEvent({ type: "system" })).toBe(true);
    });

    it("returns false for invalid events", () => {
      expect(isClaudeEvent(null)).toBe(false);
      expect(isClaudeEvent(undefined)).toBe(false);
      expect(isClaudeEvent("string")).toBe(false);
      expect(isClaudeEvent({ type: "unknown" })).toBe(false);
    });
  });

  describe("mapClaudeEvent", () => {
    it("maps init event to session event", () => {
      const events = Array.from(
        mapClaudeEvent({ type: "init", session_id: "sess-123" })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "session", sessionId: "sess-123" });
    });

    it("maps assistant_partial event to message.delta", () => {
      const events = Array.from(
        mapClaudeEvent({ type: "assistant_partial", delta: "Hello world" })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.delta",
        delta: "Hello world",
        index: undefined,
      });
    });

    it("maps assistant event with text content to message.final", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello from Claude" }],
          },
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.final",
        content: "Hello from Claude",
      });
    });

    it("maps assistant event with tool_use to tool.proposed and tool.started", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "/test.txt" },
              },
            ],
          },
        })
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "tool.proposed",
        tool: {
          id: "tool-1",
          name: "Read",
          args: { file_path: "/test.txt" },
          riskLevel: "low",
        },
      });
      expect(events[1]).toEqual({ type: "tool.started", toolId: "tool-1" });
    });

    it("maps tool_use event to tool.proposed and tool.started", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "tool_use",
          id: "tool-2",
          name: "Bash",
          input: { command: "ls -la" },
        })
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "tool.proposed",
        tool: {
          id: "tool-2",
          name: "Bash",
          args: { command: "ls -la" },
          riskLevel: "medium",
        },
      });
      expect(events[1]).toEqual({ type: "tool.started", toolId: "tool-2" });
    });

    it("maps tool_result success to tool.completed", () => {
      // First register the tool
      Array.from(mapClaudeEvent({ type: "tool_use", id: "tool-3", name: "Read", input: {} }));

      const events = Array.from(
        mapClaudeEvent({
          type: "tool_result",
          tool_use_id: "tool-3",
          content: "file contents here",
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool.completed",
        toolId: "tool-3",
        result: "file contents here",
      });
    });

    it("maps tool_result error to tool.completed with error", () => {
      Array.from(mapClaudeEvent({ type: "tool_use", id: "tool-4", name: "Read", input: {} }));

      const events = Array.from(
        mapClaudeEvent({
          type: "tool_result",
          tool_use_id: "tool-4",
          content: "File not found",
          is_error: true,
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool.completed",
        toolId: "tool-4",
        error: { message: "File not found" },
      });
    });

    it("maps result event to json event", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "result",
          session_id: "sess-123",
          cost: { input_tokens: 100, output_tokens: 50 },
          duration_ms: 1500,
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "json",
        name: "session_result.json",
        json: {
          session_id: "sess-123",
          cost: { input_tokens: 100, output_tokens: 50 },
          duration_ms: 1500,
        },
      });
    });

    it("maps result event with text content to message.final", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "result",
          session_id: "sess-123",
          result: "Final answer",
          cost: { input_tokens: 100, output_tokens: 50 },
          duration_ms: 1500,
        })
      );
      // Should have 2 events: message.final and session_result.json
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "message.final",
        content: "Final answer",
      });
      expect(events[1]).toMatchObject({
        type: "json",
        name: "session_result.json",
      });
    });

    it("maps result event with content field to message.final", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "result",
          session_id: "sess-124",
          content: "Alternative content field",
          cost: { input_tokens: 100, output_tokens: 50 },
          duration_ms: 1500,
        })
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "message.final",
        content: "Alternative content field",
      });
    });

    it("maps error event to progress event", () => {
      const events = Array.from(
        mapClaudeEvent({
          type: "error",
          error: { message: "Rate limit exceeded" },
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "progress",
        message: "[claude] error: Rate limit exceeded",
      });
    });

    it("assigns correct risk levels to tools", () => {
      // Low risk: Read
      const readEvents = Array.from(
        mapClaudeEvent({ type: "tool_use", id: "t1", name: "Read", input: {} })
      );
      expect(readEvents[0]).toMatchObject({
        tool: { riskLevel: "low" },
      });

      clearPendingTools();

      // Medium risk: Write
      const writeEvents = Array.from(
        mapClaudeEvent({ type: "tool_use", id: "t2", name: "Write", input: {} })
      );
      expect(writeEvents[0]).toMatchObject({
        tool: { riskLevel: "medium" },
      });

      clearPendingTools();

      // High risk: Bash with rm
      const rmEvents = Array.from(
        mapClaudeEvent({
          type: "tool_use",
          id: "t3",
          name: "Bash",
          input: { command: "rm -rf /tmp/test" },
        })
      );
      expect(rmEvents[0]).toMatchObject({
        tool: { riskLevel: "high" },
      });
    });

    it("returns empty array for invalid input", () => {
      expect(Array.from(mapClaudeEvent(null))).toEqual([]);
      expect(Array.from(mapClaudeEvent(undefined))).toEqual([]);
      expect(Array.from(mapClaudeEvent("string"))).toEqual([]);
    });

    it("does not emit duplicate message.final when assistant and result both have content", () => {
      // Claude Code sends both 'assistant' event (with message content) and
      // 'result' event (with same content as 'result' field)
      // We should only emit message.final once

      // First, process the assistant event
      const assistantEvents = Array.from(
        mapClaudeEvent({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello from Claude" }],
          },
        })
      );
      expect(assistantEvents).toHaveLength(1);
      expect(assistantEvents[0]).toEqual({
        type: "message.final",
        content: "Hello from Claude",
      });

      // Now process the result event with the same content
      const resultEvents = Array.from(
        mapClaudeEvent({
          type: "result",
          session_id: "sess-123",
          result: "Hello from Claude",
          cost: { input_tokens: 100, output_tokens: 50 },
          duration_ms: 1500,
        })
      );

      // Should only have the json event, NOT another message.final
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({
        type: "json",
        name: "session_result.json",
      });
    });

    it("emits message.final from result if assistant had no text content", () => {
      // If assistant only had tool_use (no text), result should emit message.final
      const assistantEvents = Array.from(
        mapClaudeEvent({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "/test.txt" },
              },
            ],
          },
        })
      );
      // Only tool events, no message.final
      expect(assistantEvents.every(e => e.type !== "message.final")).toBe(true);

      // Now result should emit message.final since assistant didn't
      const resultEvents = Array.from(
        mapClaudeEvent({
          type: "result",
          session_id: "sess-123",
          result: "Task completed",
          cost: { input_tokens: 100, output_tokens: 50 },
          duration_ms: 1500,
        })
      );

      expect(resultEvents).toHaveLength(2);
      expect(resultEvents[0]).toEqual({
        type: "message.final",
        content: "Task completed",
      });
      expect(resultEvents[1]).toMatchObject({
        type: "json",
        name: "session_result.json",
      });
    });
  });
});
