
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
} as unknown as RunStore;

const mockBus = {
    emitNodePatch: vi.fn(),
    emitNodeProgress: vi.fn(),
    emitTurnStarted: vi.fn(),
    emitTurnCompleted: vi.fn(),
} as unknown as EventBus;

const mockWorkspace = {
    prepareWorkspace: vi.fn().mockResolvedValue('/tmp/ws'),
} as unknown as WorkspaceManager;

const mockProvider = {
    runTask: vi.fn().mockImplementation(async function* () {
        yield { type: 'final', output: 'ok' };
    }),
};

const mockProviders = {
    get: vi.fn().mockReturnValue(mockProvider),
} as unknown as ProviderRegistry;

describe('Manual Turn Chat Logic', () => {
    let orchestrator: any;
    let mockChatManager: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockChatManager = {
            getPendingMessages: vi.fn().mockReturnValue([{ id: 'msg-1', content: 'Hello' }]),
            markProcessed: vi.fn().mockReturnValue(1),
            formatChatMessages: vi.fn().mockReturnValue('\nMessages:\n[user]: Hello'),
            // Mock consumeMessages to simulate filtering
            consumeMessages: vi.fn().mockImplementation((runId, selector) => {
                const msgs = [{ id: 'msg-1', content: 'Hello', nodeId: undefined }];
                const selected = msgs.filter(selector);
                if (selected.length > 0) {
                    return {
                        formatted: '\nMessages:\n[user]: Hello',
                        messages: selected
                    };
                }
                return { formatted: '', messages: [] };
            }),
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
            } as any,
        });
    });

    it('should consume messages in manualTurn and mark them processed', async () => {
        const runId = 'run-1';
        const nodeId = 'node-1';

        const mockRun = {
            id: runId,
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
        };
        vi.mocked(mockStore.getRun).mockReturnValue(mockRun as any);

        // Call manualTurn
        await orchestrator.manualTurn(runId, nodeId, "User Instruction");

        // Verify consumeMessages called
        expect(mockChatManager.consumeMessages).toHaveBeenCalledWith(runId, expect.any(Function));

        // Verify prompt contains messages (returned by mock consumeMessages)
        const runTaskCall = vi.mocked(mockProvider.runTask).mock.calls[0]?.[0];
        expect(runTaskCall.prompt).toContain("User Instruction");
        expect(runTaskCall.prompt).toContain("Messages:");
    });

    it('should NOT duplicate messages if called twice', async () => {
        const runId = 'run-1';
        const nodeId = 'node-1';

        const mockRun = {
            id: runId,
            nodes: { [nodeId]: { id: nodeId, runId, type: 'task' } },
            edges: {},
        };
        vi.mocked(mockStore.getRun).mockReturnValue(mockRun as any);

        // First call: pending messages exist (mock returns them)
        await orchestrator.manualTurn(runId, nodeId, "First");
        expect(mockChatManager.consumeMessages).toHaveBeenCalledTimes(1);

        // Modify mock to return empty for second call
        mockChatManager.consumeMessages.mockReturnValue({ formatted: '', messages: [] });

        await orchestrator.manualTurn(runId, nodeId, "Second");

        expect(mockChatManager.consumeMessages).toHaveBeenCalledTimes(2);
        const runTaskCall = vi.mocked(mockProvider.runTask).mock.calls[1]?.[0];
        expect(runTaskCall.prompt).toContain("Second");
        expect(runTaskCall.prompt).not.toContain("Messages:");
    });
});
