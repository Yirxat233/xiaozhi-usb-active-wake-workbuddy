import { EventEmitter } from "node:events";
import type { DeviceState, SpeakRecord, SpeakRequest, XiaozhiNotifier } from "./domain.js";

export class MockXiaozhiNotifier implements XiaozhiNotifier {
  private readonly emitter = new EventEmitter();
  private state: DeviceState = "idle";
  private readonly records: SpeakRecord[] = [];

  getState(): DeviceState {
    return this.state;
  }

  getRecords(): SpeakRecord[] {
    return structuredClone(this.records);
  }

  setState(state: DeviceState): void {
    this.state = state;
    this.emitter.emit("state", state);
  }

  async speak(request: SpeakRequest): Promise<boolean> {
    if (this.state !== "idle") return false;
    this.setState("connecting");
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.setState("speaking");
    this.records.push({
      request: structuredClone(request),
      ready: { session_id: request.session_id, type: "speak_ready", state: "ready" },
      sentAt: new Date().toISOString(),
    });

    if (request.event_type === "question") {
      this.setState("listening");
    } else {
      this.setState("idle");
    }
    return true;
  }

  subscribeState(listener: (state: DeviceState) => void): () => void {
    this.emitter.on("state", listener);
    return () => this.emitter.off("state", listener);
  }
}
