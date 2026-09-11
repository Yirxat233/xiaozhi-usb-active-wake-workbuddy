import assert from "node:assert/strict";
import { test } from "node:test";
import { compactForSpeech } from "../src/notification-dispatcher.js";

test("long WorkBuddy replies are compacted for a bounded cloud listening turn", () => {
  const longReply = `你好！很高兴见到你。${"这是很长的任务完成内容，".repeat(30)}`;
  const compacted = compactForSpeech(longReply, 72);
  assert.ok(compacted.length < 100);
  assert.match(compacted, /详情见网页$/);
  assert.doesNotMatch(compacted, /[*#\n]/);
});

test("short notifications remain unchanged", () => {
  assert.equal(compactForSpeech("任务已经完成。", 72), "任务已经完成。");
});
