import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceState, SpeakRecord, SpeakRequest, XiaozhiNotifier } from "./domain.js";
import { synthesizeLocalSpeech } from "./local-speech.js";

export interface UsbReply { id?: string; type: string; state?: string; error?: string; firmware?: string; local_active?: boolean }
export interface UsbTransport {
  request(message: Record<string, unknown>, timeoutMs?: number): Promise<UsbReply>;
  subscribe(listener: (reply: UsbReply) => void): () => void;
  close(): void;
}

export class PythonUsbTransport implements UsbTransport {
  private readonly worker: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, { resolve(value: UsbReply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(port = "COM5") {
    const python = process.env.XIAOZHI_PYTHON ?? resolve(process.env.USERPROFILE ?? "", ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe");
    this.worker = spawn(python, ["-u", resolve("scripts/usb-device-worker.py"), "--port", port], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: process.env.XIAOZHI_PYTHON_PACKAGES ?? resolve("firmware-flash-20260908/python-packages") },
      stdio: "pipe",
    });
    createInterface({ input: this.worker.stdout }).on("line", (line) => {
      try {
        const reply = JSON.parse(line) as UsbReply;
        if (reply.type === "transport_disconnected") this.rejectPending(new Error("设备 USB 已断开"));
        this.events.emit("message", reply);
        const entry = reply.id && this.pending.get(reply.id);
        if (entry && reply.id) {
          clearTimeout(entry.timer);
          this.pending.delete(reply.id);
          entry.resolve(reply);
        }
      } catch { /* Only the worker's JSON protocol is consumed. */ }
    });
    // Keep a narrow set of raw device state transitions in the Bridge log. The Python
    // worker filters everything else, so voice text and noisy firmware logs stay out.
    this.worker.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.worker.on("error", () => this.disconnected());
    this.worker.on("exit", () => this.disconnected());
  }
  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  private disconnected(): void {
    this.rejectPending(new Error("设备 USB 通道不可用"));
    this.events.emit("message", { type: "transport_disconnected" });
  }
  request(message: Record<string, unknown>, timeoutMs = 5000): Promise<UsbReply> {
    const id = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("设备响应超时")); }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.worker.stdin.write(`${JSON.stringify({ ...message, id })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  subscribe(listener: (reply: UsbReply) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }
  close(): void { this.rejectPending(new Error("USB 通道关闭")); this.worker.stdin.end(); this.worker.kill(); }
}

export class UsbXiaozhiNotifier implements XiaozhiNotifier {
  private state: DeviceState = "offline";
  private readonly emitter = new EventEmitter();
  private readonly records: SpeakRecord[] = [];
  private sending = false;
  private polling = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  lastError?: string;
  firmware?: string;
  constructor(
    private readonly transport: UsbTransport = new PythonUsbTransport(process.env.XIAOZHI_USB_PORT ?? "COM5"),
    private readonly synthesize: (text: string, sampleRate?: number) => Promise<Buffer[]> = synthesizeLocalSpeech,
    private readonly frameDelayMs = 60,
  ) {
    this.unsubscribe = transport.subscribe((reply) => {
      if (reply.type === "transport_disconnected") this.updateState("offline");
      if (reply.type === "transport_connected") void this.poll();
    });
    this.timer = setInterval(() => void this.poll(), 2000);
    this.timer.unref();
  }
  getState(): DeviceState { return this.state; }
  getRecords(): SpeakRecord[] { return structuredClone(this.records); }
  setState(_state: DeviceState): void { /* Hardware state is reported by the device only. */ }
  private updateState(state: DeviceState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitter.emit("state", state);
  }
  async poll(): Promise<void> {
    if (this.sending || this.polling || this.closed) return;
    this.polling = true;
    try {
      const reply = await this.transport.request({ type: "status" }, 2500);
      this.firmware = reply.firmware;
      const allowed: string[] = ["idle", "connecting", "speaking", "listening"];
      this.updateState(allowed.includes(reply.state ?? "") ? reply.state as DeviceState : "offline");
    } catch { this.updateState("offline"); }
    finally { this.polling = false; }
  }
  async speak(request: SpeakRequest): Promise<boolean> {
    if (this.state !== "idle" || this.sending || this.closed) return false;
    this.sending = true;
    this.updateState("connecting");
    let started = false;
    try {
      const instruction = request.intent === "command"
        ? request.text
        : request.event_type === "question"
          ? `播报后等待用户回答，不要代答：${request.text}`
          : `播报后结束：${request.text}`;
      const frames = await this.synthesize(instruction, 16000);
      const ready = await this.transport.request({ type: "ask_request", session_id: request.session_id, text: request.text });
      if (ready.type !== "ask_ready") throw new Error(ready.error ?? "设备当前忙碌");
      started = true;
      this.updateState("listening");
      for (let seq = 0; seq < frames.length; seq++) {
        if (this.closed) throw new Error("播报已取消");
        const ack = await this.transport.request({ type: "input_audio", session_id: request.session_id, seq, data: frames[seq]!.toString("base64") });
        if (ack.type !== "input_ack") throw new Error(ack.error ?? "设备拒绝输入音频");
        if (this.frameDelayMs) await delay(this.frameDelayMs);
      }
      const done = await this.transport.request({ type: "input_stop", session_id: request.session_id }, 90000);
      if (done.type !== "cloud_done") throw new Error(done.error ?? "小智没有完成回复");
      if (done.state && done.state !== "idle") throw new Error(`小智回复结束后状态异常：${done.state}`);
      this.records.push({ request: structuredClone(request), ready: { session_id: request.session_id, type: "speak_ready", state: "ready" }, sentAt: new Date().toISOString() });
      if (this.records.length > 100) this.records.shift();
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (started) await this.transport.request({ type: "cancel", session_id: request.session_id }, 1000).catch(() => undefined);
      return false;
    } finally {
      this.sending = false;
      // Wait for a fresh hardware status before draining the next item/retrying.
      this.updateState("offline");
    }
  }
  subscribeState(listener: (state: DeviceState) => void): () => void {
    this.emitter.on("state", listener);
    return () => this.emitter.off("state", listener);
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.unsubscribe(); this.transport.close(); }
}
