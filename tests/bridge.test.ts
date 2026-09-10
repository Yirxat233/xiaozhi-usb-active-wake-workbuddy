import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeRuntime } from "../src/bridge.js";
import { MockXiaozhiNotifier } from "../src/mock-xiaozhi.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("notifier failures retain the event without an immediate retry loop", async () => {
  class FailingNotifier extends MockXiaozhiNotifier {
    attempts = 0;
    override async speak(): Promise<boolean> { this.attempts++; throw new Error("disconnected"); }
  }
  const notifier = new FailingNotifier();
  const runtime = new BridgeRuntime({ stepDelayMs: 1000, xiaozhiNotifier: notifier });
  try {
    await runtime.workbuddy.openProject("Bridge");
    await runtime.workbuddy.continueProject();
    await sleep(50);
    assert.equal(notifier.attempts, 1);
    assert.equal(runtime.dispatcher.snapshot().queued, 1);
  } finally { runtime.close(); }
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
    await sleep(80);

    const pending = await runtime.workbuddy.listPendingQuestions();
    assert.equal(pending.length, 1);
    assert.equal(runtime.xiaozhi.getState(), "listening");

    const answer = await runtime.voiceCommand("允许继续");
    assert.match(answer.reply, /已把回答交给项目/);
    await sleep(100);

    const project = await runtime.workbuddy.getProject("voice-bridge");
    assert.equal(project.status, "completed");
    assert.equal(project.progress, 100);
    assert.ok(runtime.xiaozhi.getRecords().some((record) => record.request.event_type === "question"));
    assert.ok(runtime.xiaozhi.getRecords().some((record) => record.request.event_type === "result"));
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
    await sleep(10);
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
