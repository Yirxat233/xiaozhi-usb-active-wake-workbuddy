import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WindowsDpapiXiaozhiEndpointStore } from "../src/xiaozhi-endpoint-store.js";

test("Windows DPAPI store encrypts the Xiaozhi endpoint and can remove it", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiaozhi-dpapi-"));
  const file = join(directory, "endpoint.dpapi");
  const endpoint = "wss://api.xiaozhi.me/mcp/?token=TEST_ONLY_NOT_A_REAL_TOKEN";
  const store = new WindowsDpapiXiaozhiEndpointStore(file);
  try {
    assert.equal(await store.load(), undefined);
    await store.save(endpoint);
    const encrypted = await readFile(file, "utf8");
    assert.ok(!encrypted.includes("TEST_ONLY_NOT_A_REAL_TOKEN"));
    assert.equal(await store.load(), endpoint);
    await store.clear();
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
