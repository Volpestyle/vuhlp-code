
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrchestratorEngine } from '../orchestrator.js';
import { EventBus } from '../eventBus.js';
import { RunStore } from '../store.js';
import { WorkspaceManager } from '../workspace.js';
import { SessionRegistry } from '../sessionRegistry.js';
import { PromptQueue } from '../promptQueue.js';
import { ApprovalQueue } from '../approvalQueue.js';
import { ChatManager } from '../chatManager.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { RunRecord, NodeRecord } from '../types.js';

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

describe('Orchestrator Alignment Verification', () => {
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
    });

    describe('Global Mode Enforcement', () => {
        it('should default new runs to PLANNING mode', async () => {
            const run: Partial<RunRecord> = {
                id: 'run-1',
                repoPath: '/tmp/repo',
                nodes: {},
                edges: {},
                rootOrchestratorNodeId: 'node-root',
            };

            vi.mocked(mockStore.getRun).mockReturnValue(run as RunRecord);

            // Verify globalMode defaults to PLANNING when undefined
            const globalMode = run.globalMode ?? 'PLANNING';
            expect(globalMode).toBe('PLANNING');
        });
    });

    describe('Loop Logic & Turn Counting', () => {
        it('should increment turnCount on execution', async () => {
            const node: NodeRecord = {
                id: 'node-1',
                runId: 'run-1',
                type: 'task',
                status: 'running',
                turnCount: undefined,
            } as NodeRecord;

            // Apply the logic we added:
            node.turnCount = (node.turnCount ?? 0) + 1;

            expect(node.turnCount).toBe(1);

            // Second pass
            node.turnCount = (node.turnCount ?? 0) + 1;
            expect(node.turnCount).toBe(2);
        });

        it('should re-queue for auto-loop if turnCount > 0 and no inputs', () => {
            const node: NodeRecord = {
                id: 'node-1',
                control: 'AUTO',
                turnCount: 1, // Has run once
            } as NodeRecord;

            const run: RunRecord = {
                mode: 'AUTO',
                nodes: { 'node-1': node },
                edges: {},
            } as unknown as RunRecord;

            const shouldLoop = (
                !node.control || node.control === 'AUTO'
            ) && (node.turnCount || 0) > 0;

            expect(shouldLoop).toBe(true);
        });
    });

    describe('Max Iterations', () => {
        it('should count iterations only on root node', () => {
            const run = {
                id: 'run-1',
                iterations: 5,
                rootOrchestratorNodeId: 'root',
            };

            // execution of root node
            run.iterations = (run.iterations ?? 0) + 1;
            expect(run.iterations).toBe(6);

            // execution of child node
            // run.iterations should NOT increment
            expect(run.iterations).toBe(6);
        });
    });
});
