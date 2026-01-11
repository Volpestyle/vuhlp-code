import { randomUUID } from "node:crypto";
import { RunStore } from "./store.js";
import {
  VuhlpEvent,
  RunEvent,
  NodeEvent,
  EdgeEvent,
  ArtifactEvent,
  VerificationCompletedEvent,
  RunRecord,
} from "./types.js";
import { nowIso } from "./time.js";

type Subscriber = (event: VuhlpEvent) => void;

export class EventBus {
  private store: RunStore;
  private subscribers: Set<Subscriber> = new Set();

  constructor(store: RunStore) {
    this.store = store;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Publish an event, apply it to run state, persist, append to JSONL, and broadcast. */
  publish(event: VuhlpEvent): void {
    // Append first for durability
    this.store.appendEvent(event.runId, event);

    const run = this.store.getRun(event.runId);
    if (run) {
      this.applyToRun(run, event);
      this.store.persistRun(run);
    }

    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  // Convenience helpers

  emitRunPatch(runId: string, patch: Partial<RunRecord> & { id: string }, type: RunEvent["type"] = "run.updated"): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type,
      run: patch,
    } as RunEvent);
  }

  emitNodePatch(runId: string, nodeId: string, patch: NodeEvent["patch"], type: NodeEvent["type"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type,
      nodeId,
      patch,
    } as NodeEvent);
  }

  emitNodeProgress(runId: string, nodeId: string, message: string, raw?: unknown): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "node.progress",
      nodeId,
      message,
      raw,
    } as NodeEvent);
  }

  emitEdge(runId: string, edge: EdgeEvent["edge"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "edge.created",
      edge,
    } as EdgeEvent);
  }

  emitArtifact(runId: string, artifact: ArtifactEvent["artifact"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "artifact.created",
      artifact,
    } as ArtifactEvent);
  }

  emitVerificationCompleted(runId: string, nodeId: string, report: VerificationCompletedEvent["report"]): void {
    this.publish({
      id: randomUUID(),
      runId,
      ts: nowIso(),
      type: "verification.completed",
      nodeId,
      report,
    } as VerificationCompletedEvent);
  }

  private applyToRun(run: RunRecord, event: VuhlpEvent): void {
    run.updatedAt = event.ts;

    switch (event.type) {
      case "run.created":
      case "run.started":
      case "run.updated":
      case "run.completed":
      case "run.failed":
      case "run.stopped": {
        const e = event as RunEvent;
        Object.assign(run, e.run);
        return;
      }

      case "node.created":
      case "node.started":
      case "node.progress":
      case "node.completed":
      case "node.failed": {
        const e = event as NodeEvent;
        const existing = run.nodes[e.nodeId];
        if (!existing) {
          // node.created should include full node data via patch
          run.nodes[e.nodeId] = {
            id: e.nodeId,
            runId: run.id,
            type: "task",
            label: e.nodeId,
            status: "queued",
            createdAt: event.ts,
            ...(e.patch ?? {}),
          } as any;
        } else if (e.patch) {
          Object.assign(existing, e.patch);
        }
        return;
      }

      case "edge.created": {
        const e = event as EdgeEvent;
        run.edges[e.edge.id] = e.edge;
        return;
      }

      case "artifact.created": {
        const e = event as ArtifactEvent;
        run.artifacts[e.artifact.id] = e.artifact;
        return;
      }

      case "verification.completed": {
        // stored as node.output maybe
        const e = event as VerificationCompletedEvent;
        const node = run.nodes[e.nodeId];
        if (node) {
          node.output = e.report;
        }
        return;
      }

      default:
        return;
    }
  }
}
