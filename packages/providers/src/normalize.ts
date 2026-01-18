import type {
  ApprovalResolvedEvent,
  ApprovalRequestedEvent,
  EventEnvelope,
  MessageAssistantDeltaEvent,
  MessageAssistantFinalEvent,
  MessageAssistantThinkingDeltaEvent,
  MessageAssistantThinkingFinalEvent,
  TelemetryUsageEvent,
  ToolCompletedEvent,
  ToolProposedEvent,
  ToolStartedEvent,
  UUID
} from "@vuhlp/contracts";
import type { ParsedCliEvent } from "./cli-protocol.js";

export interface EventContext {
  runId: UUID;
  nodeId: UUID;
  now: () => string;
  makeId: () => UUID;
}

export function normalizeCliEvent(context: EventContext, event: ParsedCliEvent): EventEnvelope {
  switch (event.type) {
    case "message.assistant.delta": {
      const envelope: MessageAssistantDeltaEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        delta: event.delta
      };
      return envelope;
    }
    case "message.assistant.final": {
      const envelope: MessageAssistantFinalEvent = {
        id: event.id ?? context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        content: event.content
      };
      return envelope;
    }
    case "message.assistant.thinking.delta": {
      const envelope: MessageAssistantThinkingDeltaEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        delta: event.delta
      };
      return envelope;
    }
    case "message.assistant.thinking.final": {
      const envelope: MessageAssistantThinkingFinalEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        content: event.content
      };
      return envelope;
    }
    case "tool.proposed": {
      const envelope: ToolProposedEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        tool: event.tool
      };
      return envelope;
    }
    case "tool.started": {
      const envelope: ToolStartedEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        tool: event.tool
      };
      return envelope;
    }
    case "tool.completed": {
      const envelope: ToolCompletedEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        toolId: event.toolId,
        result: event.result,
        error: event.error
      };
      return envelope;
    }
    case "approval.requested": {
      const envelope: ApprovalRequestedEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        approvalId: event.approvalId,
        tool: event.tool,
        context: event.context
      };
      return envelope;
    }
    case "approval.resolved": {
      const envelope: ApprovalResolvedEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        approvalId: event.approvalId,
        resolution: event.resolution
      };
      return envelope;
    }
    case "telemetry.usage": {
      const envelope: TelemetryUsageEvent = {
        id: context.makeId(),
        runId: context.runId,
        ts: context.now(),
        type: event.type,
        nodeId: context.nodeId,
        provider: event.provider,
        model: event.model,
        usage: event.usage
      };
      return envelope;
    }
  }
}
