import { EventEmitter } from "events";
import type { EventEnvelope } from "@vuhlp/contracts";

export type EventListener = (event: EventEnvelope) => void;

export class EventBus {
  private emitter = new EventEmitter();

  on(listener: EventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  emit(event: EventEnvelope): void {
    this.emitter.emit("event", event);
  }
}
