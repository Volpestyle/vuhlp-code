
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorEngine } from '../orchestrator.js';
import { RunStore } from '../store.js';
import { EventBus } from '../eventBus.js';
import { WorkspaceManager } from '../workspace.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { ChatManager } from '../chatManager.js';

// Mocks
const mockStore = {
    getRun: vi.fn(),
    persistRun: vi.fn(),
    createArtifact: vi.fn(),
    addEdge: vi.fn(),
} as unknown as RunStore;

const mockBus = {
    emit: vi.fn(),
    emitNodePatch: vi.fn(),
    emitNodeProgress: vi.fn(),
    emitTurnStarted: vi.fn(),
    emitRunPatch: vi.fn(),
} as unknown as EventBus;

const mockWorkspace = {
    prepareWorkspace: vi.fn().mockResolvedValue('/tmp/ws'),
    captureGitDiff: vi.fn().mockReturnValue({ ok: true, diff: '', status: '' }),
} as unknown as WorkspaceManager;

const mockProvider = {
    runTask: vi.fn().mockImplementation(async function* () {
        yield { type: 'final', output: 'ok' };
    }),
};

const mockProviders = {
    get: vi.fn().mockReturnValue(mockProvider),
} as unknown as ProviderRegistry;

describe('Chat Injection Logic', () => {
    let orchestrator: OrchestratorEngine;
    let mockChatManager: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // This test suite originally tested Orchestrator's internal integration of ChatManager + Node Execution.
        // Now that NodeExecutor is pure (mostly), the integration logic lives in GraphScheduler (or Orchestrator facade).
        // Since we are testing "Chat Injection", we can now verify that:
        // 1. Scheduler/Orchestrator pulls messages (Tested separately or via integration)
        // 2. NodeExecutor accepts messages and puts them in prompt (THIS TEST)

        mockChatManager = {
            // We keep these mocks if we were using the facade, but for NodeExecutor unit test we might not need them if we pass string directly.
            // But let's keep facade style test for regression safety if we can.

            // For this specific test refactor, I will simulate the "Controller" (Scheduler) role in the test body
            // and verify NodeExecutor behaves as expected given the input.
        };

        orchestrator = new OrchestratorEngine({
            store: mockStore,
            bus: mockBus,
            providers: mockProviders,
            workspace: mockWorkspace,
            cfg: {
                roles: { implementer: 'mock' },
                scheduler: { maxConcurrency: 1 },
                orchestration: { maxIterations: 5 },
                verification: { commands: [] },
            },
            chatManager: mockChatManager,
            promptQueue: {} as any,
            approvalQueue: {} as any,
            sessionRegistry: {
                getByNodeId: vi.fn(),
                register: vi.fn(),
            } as any,
        });
    });

    it('should inject provided chat text into prompt', async () => {
        const runId = 'run-1';
        const nodeId = 'node-1';
        const chatText = "Messages:\n[user]: Hello";

        // Mock Run/Node state
        const mockRun = {
            id: runId,
            globalMode: 'PLANNING',
            repoPath: '/tmp',
            nodes: {
                [nodeId]: {
                    id: nodeId,
                    runId: runId,
                    type: 'task',
                    status: 'queued',
                    providerId: 'mock',
                    role: 'implementer',
                }
            },
            edges: {},
            rootOrchestratorNodeId: 'node-root',
        };
        vi.mocked(mockStore.getRun).mockReturnValue(mockRun as any);

        // Execute via nodeExecutor with injected chat text
        await orchestrator.nodeExecutor.executeNode(
            runId,
            nodeId,
            [],
            (() => new AbortController().signal)(),
            () => "PLANNING",
            chatText
        );

        // Verify prompt content passed to provider
        const runTaskCall = vi.mocked(mockProvider.runTask).mock.calls[0]?.[0];
        if (!runTaskCall) throw new Error('runTask not called');

        expect(runTaskCall.prompt).toContain(chatText);
    });

    // NOTE: The logic for "orphaned adoption" and "marking processed" 
    // effectively belongs to the GraphScheduler now (the caller).
    // This test file was testing the "God Class" internal logic.
    // I should migrate the "Adoption Logic" tests to GraphScheduler tests.
    // However, I haven't implemented that logic in GraphScheduler yet!

    // So the plan is:
    // 1. Verify NodeExecutor accepts string (Done above).
    // 2. Implement Adoption/Fetch logic in GraphScheduler (Next Step).
    // 3. Add test for GraphScheduler (or update integration test).
});
