
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
import { RunRecord, NodeRecord } from '../types.js';

describe('NodeExecutor Command Parsing', () => {
    let executor: NodeExecutor;
    let onGraphCommandMock: any;
    let onPhaseTransitionMock: any;

    // Mocks
    const storeMock = { getRun: () => ({ nodes: {}, repoPath: '/tmp' }), createArtifact: () => { } } as unknown as RunStore;
    const busMock = {
        emitNodePatch: () => { },
        emitNodeProgress: () => { },
        emitArtifact: () => { },
        emitToolProposed: () => { },
        emitMessageFinal: () => { } // Added missing mock
    } as unknown as EventBus;
    const providersMock = { get: () => ({}) } as unknown as ProviderRegistry;
    const workspaceMock = { prepareWorkspace: async () => '/tmp/ws', captureGitDiff: () => ({ ok: false }) } as unknown as WorkspaceManager;
    const sessionRegistryMock = { getByNodeId: () => null, register: () => { } } as unknown as SessionRegistry;
    const approvalQueueMock = {} as ApprovalQueue;
    const promptFactoryMock = {} as PromptFactory;

    beforeEach(() => {
        onGraphCommandMock = vi.fn().mockReturnValue("Command Executed");
        onPhaseTransitionMock = vi.fn();

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

    it('should parse valid JSON spawn_node command', async () => {
        const text = `
Here is the plan.
\`\`\`json
{
  "command": "spawn_node",
  "args": {
    "role": "investigator",
    "label": "Test Agent",
    "instructions": "Do stuff"
  }
}
\`\`\`
        `;

        // We can access private methods via 'any' cast for testing if we don't want to fully run `runProviderTask` logic
        // But `runProviderTask` is public!

        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () {
                yield { type: 'message.final', content: text, tokenCount: 0 };
            }
        } as any;

        const result = await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);

        // runProviderTask returns the final output string. 
        // Logic: handleProviderEvent handles events. 
        // BUT runProviderTask builds finalOutput.
        // It then calls parseGraphCommand(finalOutput).

        expect(onGraphCommandMock).toHaveBeenCalled();
        const cmd = onGraphCommandMock.mock.calls[0][2];
        expect(cmd.command).toBe('spawn_node');
        expect(cmd.args.label).toBe('Test Agent');
    });

    it('should parse JSON with trailing commas (relaxed parsing)', async () => {
        const text = `
\`\`\`json
{
  "command": "spawn_node",
  "args": {
    "role": "investigator",
    "label": "Relaxed Agent",
    "instructions": "Relax",
  }, 
}
\`\`\`
        `;

        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () {
                yield { type: 'message.final', content: text, tokenCount: 0 };
            }
        } as any;

        await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);

        expect(onGraphCommandMock).toHaveBeenCalled();
        const cmd = onGraphCommandMock.mock.calls[0][2];
        expect(cmd.args.label).toBe('Relaxed Agent');
    });

    it('should parse JSON without language tag', async () => {
        const text = `
\`\`\`
{
  "command": "spawn_node",
  "args": { "role": "x", "label": "NoLang", "instructions": "z" }
}
\`\`\`
        `;
        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () { yield { type: 'message.final', content: text }; }
        } as any;

        await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);
        expect(onGraphCommandMock).toHaveBeenCalled();
        expect(onGraphCommandMock.mock.calls[0][2].args.label).toBe('NoLang');
    });

    it('should parse JSON via brace balancing in mixed text', async () => {
        const text = `
        Sure I can do that.
        {
          "command": "spawn_node",
          "args": { "role": "x", "label": "Braced", "instructions": "z" }
        }
        Hope that helps.
        `;
        const node: NodeRecord = { id: 'n1', runId: 'r1' } as any;
        const provider: ProviderAdapter = {
            id: 'mock',
            runTask: async function* () { yield { type: 'message.final', content: text }; }
        } as any;

        await executor.runProviderTask('r1', node, provider, { prompt: '' }, new AbortController().signal);
        expect(onGraphCommandMock).toHaveBeenCalled();
        expect(onGraphCommandMock.mock.calls[0][2].args.label).toBe('Braced');
    });
});
