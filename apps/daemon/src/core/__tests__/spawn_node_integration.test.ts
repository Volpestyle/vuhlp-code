
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeExecutor } from '../nodeExecutor.js';
import { RunStore } from '../store.js';
import { EventBus } from '../eventBus.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { WorkspaceManager } from '../workspace.js';
import { SessionRegistry } from '../sessionRegistry.js';
import { ApprovalQueue } from '../approvalQueue.js';
import { PromptFactory } from '../promptFactory.js';
import { ProviderAdapter } from '../../providers/types.js';
import { NodeRecord } from '../types.js';

describe('Spawn Node Integration', () => {
    let executor: NodeExecutor;
    let onGraphCommandMock: any;
    let onPhaseTransitionMock: any;
    let busMock: EventBus;
    let approvalQueueMock: ApprovalQueue;

    // Mocks
    const storeMock = {
        getRun: () => ({
            nodes: {},
            repoPath: '/tmp',
            policy: { skipCliPermissions: false } // Force permissions check to ensure interception works
        }),
        createArtifact: () => { }
    } as unknown as RunStore;

    const providersMock = { get: () => ({}) } as unknown as ProviderRegistry;
    const workspaceMock = { prepareWorkspace: async () => '/tmp/ws', captureGitDiff: () => ({ ok: false }) } as unknown as WorkspaceManager;
    const sessionRegistryMock = { getByNodeId: () => null, register: () => { } } as unknown as SessionRegistry;
    const promptFactoryMock = {} as PromptFactory;

    beforeEach(() => {
        onGraphCommandMock = vi.fn().mockReturnValue("Command Executed");
        onPhaseTransitionMock = vi.fn();

        busMock = {
            emitNodePatch: vi.fn(),
            emitNodeProgress: vi.fn(),
            emitArtifact: vi.fn(),
            emitToolProposed: vi.fn(),
            emitToolStarted: vi.fn(),
            emitToolCompleted: vi.fn(),
            emitMessageFinal: vi.fn()
        } as unknown as EventBus;

        approvalQueueMock = {
            requestApproval: vi.fn()
        } as unknown as ApprovalQueue;

        executor = new NodeExecutor(
            storeMock,
            busMock,
            providersMock,
            workspaceMock,
            sessionRegistryMock,
            approvalQueueMock,
            promptFactoryMock,
            onGraphCommandMock,
            onPhaseTransitionMock
        );
    });

    it('should intercept native spawn_node tool calls and NOT trigger approval', async () => {
        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () {
                yield {
                    type: 'tool.proposed',
                    tool: {
                        id: 't1',
                        name: 'spawn_node',
                        args: { role: 'investigator', label: 'Tool Agent', instructions: 'Test' }
                    }
                };
                yield { type: 'message.final', content: 'Done' };
            }
        } as any;

        await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);

        // 1. Check if tool proposed was emitted (UI visibility)
        expect(busMock.emitToolProposed).toHaveBeenCalled();

        // 2. Check if onGraphCommand was called (INTERCEPTION)
        expect(onGraphCommandMock).toHaveBeenCalled();
        const cmd = onGraphCommandMock.mock.calls[0][2];
        expect(cmd.command).toBe('spawn_node');
        expect(cmd.args.label).toBe('Tool Agent');

        // 3. Check if approval was skipped
        expect(approvalQueueMock.requestApproval).not.toHaveBeenCalled();

        // 4. Check if tool was auto-completed
        expect(busMock.emitToolStarted).toHaveBeenCalled();
        expect(busMock.emitToolCompleted).toHaveBeenCalled();
    });

    it('should still support text-based spawn_node JSON blocks', async () => {
        const text = `
I will spawn a node now.
\`\`\`json
{
  "command": "spawn_node",
  "args": {
    "role": "implementer",
    "label": "Text Agent",
    "instructions": "Do text stuff"
  }
}
\`\`\`
        `;

        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () {
                yield { type: 'message.final', content: text };
            }
        } as any;

        await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);

        expect(onGraphCommandMock).toHaveBeenCalled();
        const cmd = onGraphCommandMock.mock.calls[0][2];
        expect(cmd.args.label).toBe('Text Agent');
    });

    it('should prioritize message.final content over subsequent final event object (Text Clobbering Fix)', async () => {
        const text = `
Here is the plan.
\`\`\`json
{
  "command": "spawn_node",
  "args": {
    "role": "investigator",
    "label": "Clobber Test",
    "instructions": "Ensure this survives final event"
  }
}
\`\`\`
        `;

        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () {
                // 1. Emit the actual content
                yield { type: 'message.final', content: text };
                // 2. Emit a final event (like Claude CLI does) with an object payload
                yield { type: 'final', output: { type: 'result', cost: 0.1 } };
            }
        } as any;

        await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);

        // Verification: The parsing should have succeeded using the TEXT from messsage.final
        // ignoring the OBJECT from final.
        expect(onGraphCommandMock).toHaveBeenCalled();
        const cmd = onGraphCommandMock.mock.calls[0][2];
        expect(cmd.args.label).toBe('Clobber Test');
    });
});
