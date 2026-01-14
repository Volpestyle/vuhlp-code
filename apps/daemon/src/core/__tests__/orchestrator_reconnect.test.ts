
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorEngine } from '../orchestrator.js';
import { EventBus } from '../eventBus.js';
import { RunStore } from '../store.js';
import { WorkspaceManager } from '../workspace.js';
import { SessionRegistry } from '../sessionRegistry.js';
import { PromptQueue } from '../promptQueue.js';
import { ApprovalQueue } from '../approvalQueue.js';
import { ChatManager } from '../chatManager.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { RunRecord, NodeRecord, NodeStatus } from '../types.js';

// Mocks
const mockStore = {
    getRun: vi.fn(),
    persistRun: vi.fn(),
    createArtifact: vi.fn(),
    addRun: vi.fn(),
    addEdge: vi.fn(),
} as unknown as RunStore;

const mockBus = {
    emit: vi.fn(),
    emitRunPatch: vi.fn(),
    emitNodePatch: vi.fn(),
    emitNodeProgress: vi.fn(),
    emitRunModeChanged: vi.fn(),
    emitRunPhaseChanged: vi.fn(),
    emitTurnStarted: vi.fn(),
    emitEdge: vi.fn(),
} as unknown as EventBus;

const mockWorkspace = {
    prepareWorkspace: vi.fn().mockResolvedValue('/tmp/ws'),
} as unknown as WorkspaceManager;

const mockProviders = {
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
} as unknown as ProviderRegistry;

describe('Orchestrator Restart Node', () => {
    let orchestrator: OrchestratorEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        orchestrator = new OrchestratorEngine({
            store: mockStore,
            bus: mockBus,
            providers: mockProviders,
            workspace: mockWorkspace,
            cfg: {
                roles: { implementer: 'mock' },
                scheduler: { maxConcurrency: 2 },
                orchestration: { maxIterations: 5 },
                verification: { commands: [] },
            },
            chatManager: {} as ChatManager,
            promptQueue: {} as PromptQueue,
            approvalQueue: {} as ApprovalQueue,
            sessionRegistry: {} as SessionRegistry,
        });

        // Mock resumeRun to prevent actual scheduling call
        orchestrator.resumeRun = vi.fn();
    });

    it('should restart a completed node', () => {
        const nodeId = 'node-1';
        const runId = 'run-1';

        const node: NodeRecord = {
            id: nodeId,
            runId,
            type: 'task',
            status: 'completed',
            error: { message: 'old error' },
        } as NodeRecord;

        const run: Partial<RunRecord> = {
            id: runId,
            status: 'running',
            nodes: { [nodeId]: node },
        };

        vi.mocked(mockStore.getRun).mockReturnValue(run as RunRecord);

        const result = orchestrator.restartNode(runId, nodeId);

        expect(result).toBe(true);
        expect(node.status).toBe('queued');
        expect(node.error).toBeUndefined();
        expect(mockStore.persistRun).toHaveBeenCalledWith(run);
        expect(mockBus.emitNodePatch).toHaveBeenCalledWith(runId, nodeId, { status: 'queued', error: undefined }, 'node.progress');
    });

    it('should resume run if paused/stopped when restarting node', () => {
        const nodeId = 'node-1';
        const runId = 'run-1';

        const node: NodeRecord = {
            id: nodeId,
            runId,
            type: 'task',
            status: 'failed',
        } as NodeRecord;

        const run: Partial<RunRecord> = {
            id: runId,
            status: 'paused', // Run is paused
            nodes: { [nodeId]: node },
        };

        vi.mocked(mockStore.getRun).mockReturnValue(run as RunRecord);

        const result = orchestrator.restartNode(runId, nodeId);

        expect(result).toBe(true);
        expect(node.status).toBe('queued');
        // Check if resumeRun was called (we mocked it on the instance)
        expect(orchestrator.resumeRun).toHaveBeenCalledWith(runId);
    });

    it('should return false if node does not exist', () => {
        const run: Partial<RunRecord> = {
            id: 'run-1',
            nodes: {},
        };
        vi.mocked(mockStore.getRun).mockReturnValue(run as RunRecord);

        const result = orchestrator.restartNode('run-1', 'non-existent');
        expect(result).toBe(false);
    });
});
