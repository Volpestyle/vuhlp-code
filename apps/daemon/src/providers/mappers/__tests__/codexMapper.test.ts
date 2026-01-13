import { describe, it, expect } from "vitest";
import { mapCodexEvent, isCodexEvent } from "../codexMapper.js";

describe("codexMapper", () => {
  describe("isCodexEvent", () => {
    it("returns true for valid Codex event types", () => {
      expect(isCodexEvent({ type: "thread.started" })).toBe(true);
      expect(isCodexEvent({ type: "turn.started" })).toBe(true);
      expect(isCodexEvent({ type: "turn.completed" })).toBe(true);
      expect(isCodexEvent({ type: "item" })).toBe(true);
    });

    it("returns false for invalid events", () => {
      expect(isCodexEvent(null)).toBe(false);
      expect(isCodexEvent(undefined)).toBe(false);
      expect(isCodexEvent("string")).toBe(false);
      expect(isCodexEvent({ type: "unknown" })).toBe(false);
    });
  });

  describe("mapCodexEvent", () => {
    it("maps thread.started event to session event", () => {
      const events = Array.from(
        mapCodexEvent({ type: "thread.started", thread_id: "thread-abc" })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "session", sessionId: "thread-abc" });
    });

    it("maps item with message to message.final", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "message", role: "assistant", content: "Hello from Codex" },
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.final",
        content: "Hello from Codex",
      });
    });

    it("ignores user messages", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "message", role: "user", content: "User input" },
        })
      );
      expect(events).toHaveLength(0);
    });

    it("maps item with reasoning to message.reasoning", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "reasoning", content: "Let me think about this..." },
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "message.reasoning",
        content: "Let me think about this...",
      });
    });

    it("maps command_execution to tool.proposed and tool.started", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "command_execution", command: "ls -la", status: "running" },
        })
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "tool.proposed",
        tool: {
          name: "command_execution",
          args: { command: "ls -la" },
          riskLevel: "low",
        },
      });
      expect(events[1]).toMatchObject({ type: "tool.started" });
    });

    it("maps completed command_execution to tool.completed", () => {
      // When status is "completed", only tool.completed is emitted
      // (tool.proposed/started were emitted when status was "running")
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: {
            type: "command_execution",
            command: "cat file.txt",
            status: "completed",
            output: "file contents",
            exit_code: 0,
          },
        })
      );

      const completedEvent = events.find((e) => e.type === "tool.completed");

      expect(completedEvent).toBeDefined();
      expect(completedEvent).toMatchObject({
        type: "tool.completed",
        result: { output: "file contents", exit_code: 0 },
      });
    });

    it("maps failed command_execution to tool.completed with error", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: {
            type: "command_execution",
            command: "invalid-cmd",
            status: "failed",
          },
        })
      );

      const completedEvent = events.find((e) => e.type === "tool.completed");
      expect(completedEvent).toMatchObject({
        type: "tool.completed",
        error: { message: "Command failed: invalid-cmd" },
      });
    });

    it("maps file_change to diff event", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: {
            type: "file_change",
            path: "/src/app.ts",
            diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n+// new line",
          },
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "diff",
        name: "/src/app.ts.patch",
        patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n+// new line",
      });
    });

    it("maps web_search to json event", () => {
      const events = Array.from(
        mapCodexEvent({
          type: "item",
          item: {
            type: "web_search",
            query: "typescript best practices",
            results: [{ title: "Result 1", url: "https://example.com" }],
          },
        })
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "json",
        name: "web_search_results.json",
        json: {
          query: "typescript best practices",
          results: [{ title: "Result 1", url: "https://example.com" }],
        },
      });
    });

    it("assigns correct risk levels to commands", () => {
      // Low risk: ls
      const lsEvents = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "command_execution", command: "ls -la" },
        })
      );
      expect(lsEvents[0]).toMatchObject({
        tool: { riskLevel: "low" },
      });

      // High risk: rm
      const rmEvents = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "command_execution", command: "rm -rf /tmp" },
        })
      );
      expect(rmEvents[0]).toMatchObject({
        tool: { riskLevel: "high" },
      });

      // Medium risk: npm install
      const npmEvents = Array.from(
        mapCodexEvent({
          type: "item",
          item: { type: "command_execution", command: "npm install express" },
        })
      );
      expect(npmEvents[0]).toMatchObject({
        tool: { riskLevel: "medium" },
      });
    });

    it("returns empty array for invalid input", () => {
      expect(Array.from(mapCodexEvent(null))).toEqual([]);
      expect(Array.from(mapCodexEvent(undefined))).toEqual([]);
      expect(Array.from(mapCodexEvent("string"))).toEqual([]);
    });

    it("returns empty array for turn lifecycle events", () => {
      expect(Array.from(mapCodexEvent({ type: "turn.started", turn_id: "t1" }))).toEqual([]);
      expect(Array.from(mapCodexEvent({ type: "turn.completed", turn_id: "t1" }))).toEqual([]);
    });
  });
});
