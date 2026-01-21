import type { Envelope, ToolEvent } from '@vuhlp/contracts';
import type {
    TimelineItem,
    TimelineMessageBase,
    TimelineStatusBase,
    TimelineToolBase,
} from './timeline.js';

export const isHandoffToolName = (name: string): boolean =>
    name === 'send_handoff' || name === 'receive_handoff';

export const isHandoffToolEvent = (event: ToolEvent): boolean =>
    isHandoffToolName(event.tool.name);

export const isHandoffTimelineItem = <
    Message extends TimelineMessageBase,
    Tool extends TimelineToolBase & { tool: { name: string } },
    Status extends TimelineStatusBase
>(
    item: TimelineItem<Message, Tool, Status>
): boolean => item.type === 'tool' && isHandoffToolName(item.data.tool.name);

export const buildReceiveHandoffToolEvent = (handoff: Envelope): ToolEvent => {
    const toolId = `handoff-${handoff.id}`;
    const payload = handoff.payload;
    const args: {
        envelopeId: string;
        from: string;
        to: string;
        message: string;
        structured?: Envelope['payload']['structured'];
        artifacts?: Envelope['payload']['artifacts'];
        status?: Envelope['payload']['status'];
        response?: Envelope['payload']['response'];
        contextRef?: string;
    } = {
        envelopeId: handoff.id,
        from: handoff.fromNodeId,
        to: handoff.toNodeId,
        message: payload.message,
    };

    if (payload.structured) {
        args.structured = payload.structured;
    }
    if (payload.artifacts) {
        args.artifacts = payload.artifacts;
    }
    if (payload.status) {
        args.status = payload.status;
    }
    if (payload.response) {
        args.response = payload.response;
    }
    if (handoff.contextRef) {
        args.contextRef = handoff.contextRef;
    }

    return {
        id: toolId,
        nodeId: handoff.toNodeId,
        tool: {
            id: toolId,
            name: 'receive_handoff',
            args,
        },
        status: 'completed',
        timestamp: handoff.createdAt,
    };
};
