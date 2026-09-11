import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeRuntime } from "../src/bridge.js";
import { MockXiaozhiNotifier } from "../src/mock-xiaozhi.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (predicate: () => boolean, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("等待条件超时");
};

test("notifier failures retain the event without an immediate retry loop", async () => {
  class FailingNotifier extends MockXiaozhiNotifier {
    attempts = 0;
    override async speak(): Promise<boolean> { this.attempts++; throw new Error("disconnected"); }
  }
  const notifier = new FailingNotifier();
  const runtime = new BridgeRuntime({ stepDelayMs: 20, xiaozhiNotifier: notifier });
  try {
    await runtime.workbuddy.openProject("Bridge");
    await runtime.workbuddy.continueProject();
    await waitFor(() => notifier.attempts === 1);
    assert.equal(notifier.attempts, 1);
    assert.equal(runtime.dispatcher.snapshot().queued, 1);
  } finally { runtime.close(); }
});

test("pending notifications survive a Bridge restart and drain once the device is idle", async () => {
  class FailingNotifier extends MockXiaozhiNotifier {
    override async speak(): Promise<boolean> { return false; }
  }
  const directory = await mkdtemp(join(tmpdir(), "xiaozhi-notification-"));
  const queueFile = join(directory, "queue.json");
  try {
    const first = new BridgeRuntime({
      stepDelayMs: 20,
      xiaozhiNotifier: new FailingNotifier(),
      notificationQueueFile: queueFile,
    });
    await first.workbuddy.openProject("主动唤醒");
    await first.workbuddy.continueProject();
    await waitFor(() => first.dispatcher.snapshot().queued === 1);
    first.close();

    const notifier = new MockXiaozhiNotifier();
    const restarted = new BridgeRuntime({ stepDelayMs: 20, xiaozhiNotifier: notifier, notificationQueueFile: queueFile });
    try {
      await waitFor(() => notifier.getRecords().length === 1);
      assert.equal(restarted.dispatcher.snapshot().queued, 0);
      assert.match(notifier.getRecords()[0]?.request.text ?? "", /等待你的回答/);
    } finally { restarted.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("voice commands list, open and continue a project", async () => {
  const runtime = new BridgeRuntime({ stepDelayMs: 30 });
  try {
    const list = await runtime.voiceCommand("查询一下近三天的项目清单");
    assert.match(list.reply, /小智 WorkBuddy Bridge/);

    const opened = await runtime.voiceCommand("打开 Bridge 项目");
    assert.match(opened.reply, /已经打开/);

    const continued = await runtime.voiceCommand("继续执行项目");
    assert.match(continued.reply, /继续执行/);
    await waitFor(() => runtime.xiaozhi.getState() === "listening");

    const pending = await runtime.workbuddy.listPendingQuestions();
    assert.equal(pending.length, 1);
    assert.equal(runtime.xiaozhi.getState(), "listening");

    const answer = await runtime.voiceCommand("允许继续");
    assert.match(answer.reply, /已把回答交给项目/);
    await sleep(100);

    const project = await runtime.workbuddy.getProject("voice-bridge");
    assert.equal(project.status, "completed");
    assert.equal(project.progress, 100);
    const questionNotice = runtime.xiaozhi.getRecords().find((record) => record.request.event_type === "question");
    const resultNotice = runtime.xiaozhi.getRecords().find((record) => record.request.event_type === "result");
    assert.match(questionNotice?.request.text ?? "", /WorkBuddy 项目“小智 WorkBuddy Bridge”.*等待你的回答/);
    assert.match(resultNotice?.request.text ?? "", /“小智 WorkBuddy Bridge”已完成.*详情见网页/);
  } finally {
    runtime.close();
  }
});

test("notifications wait while device is busy and drain when idle", async () => {
  const runtime = new BridgeRuntime({ stepDelayMs: 30 });
  try {
    runtime.xiaozhi.setState("speaking");
    await runtime.workbuddy.openProject("Bridge");
    await runtime.workbuddy.continueProject();
    await sleep(75);
    assert.equal(runtime.xiaozhi.getRecords().length, 0);
    assert.equal(runtime.dispatcher.snapshot().queued, 1);

    runtime.xiaozhi.setState("idle");
    await sleep(15);
    assert.equal(runtime.xiaozhi.getRecords().length, 1);
  } finally {
    runtime.close();
  }
});

test("voice command creates a project and open-project can carry an instruction", async () => {
  const runtime = new BridgeRuntime({ stepDelayMs: 30 });
  try {
    const created = await runtime.voiceCommand("创建一个叫做 实际输出 项目并发送指令：只回复已创建");
    assert.match(created.reply, /已经创建/);
    assert.equal((created.data as { status: string }).status, "running");

    await sleep(80);
    const opened = await runtime.voiceCommand("打开 Bridge 项目并发送指令：继续做连接测试");
    assert.match(opened.reply, /指令提交到 WorkBuddy/);
    assert.equal((opened.data as { status: string }).status, "running");
  } finally {
    runtime.close();
  }
});
