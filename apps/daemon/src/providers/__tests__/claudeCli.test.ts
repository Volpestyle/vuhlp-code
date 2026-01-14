
import { describe, it, expect } from "vitest";
import { ClaudeCliProvider, ClaudeCliConfig } from "../claudeCli";
import { ProviderTask } from "../types";

describe("ClaudeCliProvider", () => {
    const baseConfig: ClaudeCliConfig = {
        kind: "claude-cli",
        command: "claude",
    };

    const baseTask: ProviderTask = {
        runId: "run-1",
        nodeId: "node-1",
        role: "implementer",
        prompt: "Hello",
        skipPermissions: true,
        workspacePath: "/tmp/workspace",
    };

    it("should add --resume when sessionId is provided with default args", () => {
        const provider = new ClaudeCliProvider("claude", baseConfig);
        const task = { ...baseTask, sessionId: "sess-123" };

        // access private buildArgs via checking runTask (mock generator?) 
        // or better, just cast to any to test the private method logic directly for unit testing
        // or we can refactor buildArgs to be public/internal. 
        // For now, let's access it via 'any' to avoid public API changes just for testing.
        const args = (provider as any).buildArgs(task, "prompt");

        expect(args).toContain("--resume");
        expect(args).toContain("sess-123");
    });

    it("should add --resume when sessionId is provided even with custom args", () => {
        const config = { ...baseConfig, args: ["custom", "arg"] };
        const provider = new ClaudeCliProvider("claude", config);
        const task = { ...baseTask, sessionId: "sess-123" };

        const args = (provider as any).buildArgs(task, "prompt");

        expect(args).toContain("custom");
        expect(args).toContain("arg");
        expect(args).toContain("--resume");
        expect(args).toContain("sess-123");
    });

    it("should NOT add --resume if no sessionId", () => {
        const provider = new ClaudeCliProvider("claude", baseConfig);
        const task = { ...baseTask, sessionId: undefined };

        const args = (provider as any).buildArgs(task, "prompt");

        expect(args).not.toContain("--resume");
    });

    it("should not duplicate --resume if already in custom args", () => {
        const config = { ...baseConfig, args: ["--resume", "manual-id"] };
        const provider = new ClaudeCliProvider("claude", config);
        const task = { ...baseTask, sessionId: "sess-123" }; // Task has one, but config has override

        const args = (provider as any).buildArgs(task, "prompt");

        // Should preserve user's manual configured one and NOT add another? 
        // Or prefer the task one? 
        // Current design goal: If user explicitly put it in, we probably shouldn't mess with it,
        // OR we should trust the task.sessionId which comes from the registry.
        // Let's assume for this test we want to avoid duplication.
        const resumeCount = args.filter((a: string) => a === "--resume").length;
        expect(resumeCount).toBe(1);
    });
});
