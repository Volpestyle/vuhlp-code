import type { TurnStatus } from "@vuhlp/contracts";

export interface TimelineMessageBase {
  id: string;
  createdAt: string;
  content: string;
  thinking?: string;
}

export interface TimelineToolBase {
  id: string;
  timestamp: string;
}

export interface TimelineStatusBase {
  id: string;
  timestamp: string;
}

export type TimelineItem<
  Message extends TimelineMessageBase,
  Tool extends TimelineToolBase,
  Status extends TimelineStatusBase
> =
  | { type: "message"; data: Message }
  | { type: "tool"; data: Tool }
  | { type: "status"; data: Status };

export function buildTimeline<
  Message extends TimelineMessageBase,
  Tool extends TimelineToolBase,
  Status extends TimelineStatusBase
>(
  messages: Message[],
  tools: Tool[],
  statuses: Status[]
): Array<TimelineItem<Message, Tool, Status>> {
  const timeline: Array<TimelineItem<Message, Tool, Status>> = [];

  for (const message of messages) {
    timeline.push({ type: "message", data: message });
  }
  for (const tool of tools) {
    timeline.push({ type: "tool", data: tool });
  }
  for (const status of statuses) {
    timeline.push({ type: "status", data: status });
  }

  return timeline.sort((a, b) => {
    const timeA = new Date(a.type === "message" ? a.data.createdAt : a.data.timestamp).getTime();
    const timeB = new Date(b.type === "message" ? b.data.createdAt : b.data.timestamp).getTime();
    return timeA - timeB;
  });
}

export function buildTimelineUpdateKey<
  Message extends TimelineMessageBase,
  Tool extends TimelineToolBase,
  Status extends TimelineStatusBase
>(
  timeline: Array<TimelineItem<Message, Tool, Status>>
): string {
  const lastItem = timeline[timeline.length - 1];
  if (!lastItem) return "";
  if (lastItem.type === "message") {
    const thinkingLength = lastItem.data.thinking ? lastItem.data.thinking.length : 0;
    return `${lastItem.data.id}-${lastItem.data.createdAt}-${lastItem.data.content.length}-${thinkingLength}`;
  }
  return `${lastItem.data.id}-${lastItem.data.timestamp}`;
}

export function formatTurnSummary(status: TurnStatus, detail?: string): string {
  if (detail && detail.trim().length > 0) {
    return detail;
  }
  switch (status) {
    case "turn.started":
      return "turn started";
    case "waiting_for_model":
      return "waiting for model";
    case "tool.pending":
      return "tool pending";
    case "awaiting_approval":
      return "awaiting approval";
    case "turn.completed":
      return "turn completed";
    case "turn.interrupted":
      return "turn interrupted";
    case "turn.failed":
      return "turn failed";
    default:
      return "turn update";
  }
}
