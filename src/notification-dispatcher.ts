import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SpeakRequest, WorkBuddyAdapter, WorkBuddyEvent, XiaozhiNotifier } from "./domain.js";

export interface DispatcherSnapshot {
  deviceState: string;
  queued: number;
  queuedEvents: WorkBuddyEvent[];
  persistenceFile?: string;
  persistenceError?: string;
}

interface PersistedDispatcherState {
  version: 1;
  queue: WorkBuddyEvent[];
  seen: string[];
}

const isEvent = (value: unknown): value is WorkBuddyEvent => {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<WorkBuddyEvent>;
  return typeof event.id === "string" && typeof event.projectId === "string"
    && typeof event.projectName === "string" && typeof event.summary === "string"
    && typeof event.createdAt === "string"
    && ["question", "result", "error"].includes(event.type ?? "");
};

export const compactForSpeech = (value: string, maximum = 72): string => {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, "代码内容")
    .replace(/[*_#>`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maximum) return cleaned;
  const prefix = cleaned.slice(0, maximum);
  const sentenceEnd = Math.max(
    prefix.lastIndexOf("。"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"),
    prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"),
  );
  const summary = (sentenceEnd >= 18 ? prefix.slice(0, sentenceEnd + 1) : prefix)
    .replace(/[，,；;：:\s]+$/g, "");
  return `${summary}。详情见网页`;
};

export class NotificationDispatcher {
  private readonly queue: WorkBuddyEvent[] = [];
  private readonly seen = new Set<string>();
  private draining = false;
  private closed = false;
  private retryTimer?: NodeJS.Timeout;
  private readonly unsubscribers: Array<() => void> = [];
  private persistenceError?: string;

  constructor(
    workbuddy: WorkBuddyAdapter,
    private readonly xiaozhi: XiaozhiNotifier,
    private readonly persistenceFile?: string,
  ) {
    this.restore();
    this.unsubscribers.push(workbuddy.subscribe((event) => this.enqueue(event)));
    this.unsubscribers.push(xiaozhi.subscribeState((state) => {
      if (state === "idle") void this.drain();
    }));
    if (this.queue.length && xiaozhi.getState() === "idle") queueMicrotask(() => void this.drain());
  }

  snapshot(): DispatcherSnapshot {
    return {
      deviceState: this.xiaozhi.getState(),
      queued: this.queue.length,
      queuedEvents: structuredClone(this.queue),
      persistenceFile: this.persistenceFile,
      persistenceError: this.persistenceError,
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  }

  private enqueue(event: WorkBuddyEvent): void {
    if (event.type === "progress") return;
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (event.type === "question" || event.type === "error") this.queue.unshift(event);
    else this.queue.push(event);
    this.persist();
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
      text: this.notificationText(event),
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
      this.persist();
      this.draining = false;
      if (!this.closed && this.queue.length && this.xiaozhi.getState() === "idle") {
        if (accepted) queueMicrotask(() => void this.drain());
        else this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.drain(); }, 2000);
      }
    }
  }

  private notificationText(event: WorkBuddyEvent): string {
    const projectName = compactForSpeech(event.projectName, 36);
    if (event.type === "result") return `WorkBuddy 项目“${projectName}”任务已完成。`;
    const summary = compactForSpeech(event.summary, event.type === "error" ? 48 : 60);
    if (event.type === "question") return `WorkBuddy 项目“${projectName}”正在等待你的回答：${summary}`;
    if (event.type === "error") return `WorkBuddy 项目“${projectName}”执行失败：${summary}`;
    return `WorkBuddy 项目“${projectName}”任务已完成。`;
  }

  private restore(): void {
    if (!this.persistenceFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistenceFile, "utf8")) as Partial<PersistedDispatcherState>;
      const queue = Array.isArray(parsed.queue) ? parsed.queue.filter(isEvent) : [];
      const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((id): id is string => typeof id === "string") : [];
      this.queue.push(...queue);
      for (const id of [...seen, ...queue.map((event) => event.id)].slice(-1000)) this.seen.add(id);
      this.persistenceError = undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.persistenceError = error instanceof Error ? error.message : String(error);
    }
  }

  private persist(): void {
    if (!this.persistenceFile) return;
    try {
      mkdirSync(dirname(this.persistenceFile), { recursive: true });
      const temporary = `${this.persistenceFile}.${process.pid}.tmp`;
      const state: PersistedDispatcherState = {
        version: 1,
        queue: this.queue,
        seen: [...this.seen].slice(-1000),
      };
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(temporary, this.persistenceFile);
      this.persistenceError = undefined;
    } catch (error) {
      this.persistenceError = error instanceof Error ? error.message : String(error);
    }
  }
}
