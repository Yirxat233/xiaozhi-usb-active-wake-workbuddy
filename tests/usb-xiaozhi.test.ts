import assert from "node:assert/strict";
import { test } from "node:test";
import { UsbXiaozhiNotifier, type UsbReply, type UsbTransport } from "../src/usb-xiaozhi.js";
import { parseOggOpus } from "../src/local-speech.js";
import type { SpeakRequest } from "../src/domain.js";

class FakeUsb implements UsbTransport {
  messages: Record<string, unknown>[] = [];
  state = "idle";
  rejectAudio = false;
  rejectDone = false;
  async request(message: Record<string, unknown>): Promise<UsbReply> {
    this.messages.push(message);
    if (message.type === "status") return { type: "status", state: this.state };
    if (message.type === "speak_request") return { type: this.state === "idle" ? "speak_ready" : "busy" };
    if (message.type === "ask_request") return { type: this.state === "idle" ? "ask_ready" : "busy" };
    if (message.type === "audio") return { type: this.rejectAudio ? "error" : "audio_ack" };
    if (message.type === "input_audio") return { type: this.rejectAudio ? "error" : "input_ack" };
    if (message.type === "tts_stop") return { type: this.rejectDone ? "error" : "speak_done", state: "idle" };
    if (message.type === "input_stop") return { type: this.rejectDone ? "error" : "cloud_done" };
    return { type: "cancelled" };
  }
  subscribe(): () => void { return () => undefined; }
  close(): void {}
}

const request: SpeakRequest = { type: "speak_request", session_id: 'session-"quoted', text: "任务已完成",
  event_id: "event1", event_type: "result" };

test("USB notifier requires ready, audio acknowledgements and completion before recording success", async () => {
  const usb = new FakeUsb();
  const notifier = new UsbXiaozhiNotifier(usb, async () => [Buffer.from([1, 2]), Buffer.from([3])], 0);
  try {
    await notifier.poll();
    assert.equal(await notifier.speak(request), true);
    assert.deepEqual(usb.messages.map((item) => item.type), ["status", "speak_request", "audio", "audio", "tts_stop"]);
    assert.equal(usb.messages[2]!.session_id, request.session_id);
    assert.equal(usb.messages[3]!.seq, 1);
    assert.equal(notifier.getRecords().length, 1);
    assert.equal(notifier.getState(), "offline", "fresh status is required before next notification");
  } finally { notifier.close(); }
});

test("USB question notification asks the user instead of answering WorkBuddy", async () => {
  const usb = new FakeUsb();
  let synthesized = "";
  const notifier = new UsbXiaozhiNotifier(usb, async (text) => { synthesized = text; return [Buffer.from([1])]; }, 0);
  try {
    await notifier.poll();
    assert.equal(await notifier.speak({ ...request, event_type: "question", text: "项目等待选择 1 或 2" }), true);
    assert.match(synthesized, /等待用户回答，不要代答/);
  } finally { notifier.close(); }
});

test("USB command mode sends the exact user command without notification wrapping", async () => {
  const usb = new FakeUsb();
  let synthesized = "";
  const notifier = new UsbXiaozhiNotifier(usb, async (text) => { synthesized = text; return [Buffer.from([1])]; }, 0);
  try {
    await notifier.poll();
    const command = "让 WorkBuddy 的 text2 项目只回复 USB_CLOUD_OK";
    assert.equal(await notifier.speak({ ...request, intent: "command", text: command }), true);
    assert.equal(synthesized, command);
  } finally { notifier.close(); }
});

test("USB notifier neither interrupts a conversation nor fabricates success after playback failure", async () => {
  const usb = new FakeUsb();
  const notifier = new UsbXiaozhiNotifier(usb, async () => [Buffer.from([1])], 0);
  try {
    usb.state = "listening";
    await notifier.poll();
    assert.equal(await notifier.speak(request), false);
    assert.equal(usb.messages.length, 1);
    usb.state = "idle";
    await notifier.poll();
    usb.rejectDone = true;
    assert.equal(await notifier.speak({ ...request, event_type: "question" }), false);
    assert.equal(notifier.getRecords().length, 0);
    assert.equal(usb.messages.at(-1)!.type, "cancel");
  } finally { notifier.close(); }
});

function page(lacing: number[], payload: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS");
  header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), payload]);
}

test("Ogg demux handles a packet spanning pages and rejects truncated audio", () => {
  const head = Buffer.alloc(19); head.write("OpusHead"); head[9] = 1;
  const tags = Buffer.from("OpusTags");
  const frame = Buffer.alloc(300, 42);
  const stream = Buffer.concat([page([19, 8], Buffer.concat([head, tags])),
    page([255], frame.subarray(0, 255)), page([45], frame.subarray(255))]);
  assert.deepEqual(parseOggOpus(stream), [frame]);
  assert.throws(() => parseOggOpus(stream.subarray(0, -1)), /Truncated/);
});
