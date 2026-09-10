import { randomUUID } from "node:crypto";
import type { SpeakRequest, WorkBuddyAdapter, WorkBuddyEvent, XiaozhiNotifier } from "./domain.js";

export interface DispatcherSnapshot {
  deviceState: string;
  queued: number;
  queuedEvents: WorkBuddyEvent[];
}

export class NotificationDispatcher {
  private readonly queue: WorkBuddyEvent[] = [];
  private readonly seen = new Set<string>();
  private draining = false;
  private closed = false;
  private retryTimer?: NodeJS.Timeout;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    workbuddy: WorkBuddyAdapter,
    private readonly xiaozhi: XiaozhiNotifier,
  ) {
    this.unsubscribers.push(workbuddy.subscribe((event) => this.enqueue(event)));
    this.unsubscribers.push(xiaozhi.subscribeState((state) => {
      if (state === "idle") void this.drain();
    }));
  }

  snapshot(): DispatcherSnapshot {
    return {
      deviceState: this.xiaozhi.getState(),
      queued: this.queue.length,
      queuedEvents: structuredClone(this.queue),
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  }

  private enqueue(event: WorkBuddyEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (event.type === "question" || event.type === "error") this.queue.unshift(event);
    else this.queue.push(event);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.closed || this.draining || this.retryTimer || this.xiaozhi.getState() !== "idle") return;
    const event = this.queue.shift();
    if (!event) return;
    this.draining = true;
    const request: SpeakRequest = {
      session_id: randomUUID(),
      type: "speak_request",
      text: event.summary,
      event_id: event.id,
      event_type: event.type,
    };
    let accepted = false;
    try {
      accepted = await this.xiaozhi.speak(request);
      if (!accepted) this.queue.unshift(event);
    } catch {
      this.queue.unshift(event);
    } finally {
      this.draining = false;
      if (!this.closed && this.queue.length && this.xiaozhi.getState() === "idle") {
        if (accepted) queueMicrotask(() => void this.drain());
        else this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.drain(); }, 2000);
      }
    }
  }
}
