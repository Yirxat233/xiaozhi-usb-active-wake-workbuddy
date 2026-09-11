import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startBridgeServer } from "../src/http-server.js";

test("MCP Streamable HTTP exposes bridge tools", async () => {
  const bridge = await startBridgeServer({ port: 0, stepDelayMs: 30 });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp`)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "workbuddy_continue_project"));
    assert.ok(tools.tools.some((tool) => tool.name === "workbuddy_send_message"));
    assert.ok(tools.tools.some((tool) => tool.name === "workbuddy_create_project"));
    assert.ok(tools.tools.some((tool) => tool.name === "xiaozhi_bridge_status"));

    const result = await client.callTool({
      name: "workbuddy_list_projects",
      arguments: { recent_days: 3 },
    });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent);

    const refusedFuzzy = await client.callTool({
      name: "workbuddy_send_message",
      arguments: { project: "Bridge", message: "不应模糊投递" },
    });
    assert.equal(refusedFuzzy.isError, true);
    assert.match((refusedFuzzy.content as Array<{ type: string; text: string }>)[0]?.text ?? "", /禁止模糊投递/);

    const sent = await client.callTool({
      name: "workbuddy_send_message",
      arguments: { project: "小智 WorkBuddy Bridge", message: "继续连接测试" },
    });
    assert.equal(sent.isError, undefined);
    assert.match((sent.content as Array<{ type: string; text: string }>)[0]?.text ?? "", /消息已经发送到 WorkBuddy 项目/);
  } finally {
    await client.close();
    await bridge.close();
  }
});

test("HTTP voice endpoint drives the same runtime", async () => {
  const bridge = await startBridgeServer({ port: 0, stepDelayMs: 30 });
  try {
    const response = await fetch(`${bridge.baseUrl}/api/voice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "查询一下近三天的项目清单" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { reply: string };
    assert.match(body.reply, /近三天共有2个项目/);
  } finally {
    await bridge.close();
  }
});

test("HTTP USB command endpoint preserves command intent", async () => {
  const bridge = await startBridgeServer({ port: 0, stepDelayMs: 30 });
  try {
    const response = await fetch(`${bridge.baseUrl}/api/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "让 WorkBuddy 继续项目", mode: "command" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { accepted: boolean; mode: string };
    assert.deepEqual(body, { accepted: true, mode: "command" });
    assert.equal(bridge.runtime.xiaozhi.getRecords()[0]?.request.intent, "command");

    const stagedResponse = await fetch(`${bridge.baseUrl}/api/usb/workbuddy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "小智 WorkBuddy Bridge", message: "精确消息" }),
    });
    assert.equal(stagedResponse.status, 200);
    const staged = await stagedResponse.json() as { accepted: boolean; dispatched: boolean; attempts: number; project: string };
    assert.equal(staged.accepted, true);
    assert.equal(staged.dispatched, false, "mock Xiaozhi does not call the cloud MCP server");
    assert.equal(staged.attempts, 3);
    assert.equal(staged.project, "小智 WorkBuddy Bridge");
  } finally {
    await bridge.close();
  }
});

test("web console, diagnostic snapshot and MCP probe are available", async () => {
  const bridge = await startBridgeServer({ port: 0, stepDelayMs: 30 });
  try {
    const consoleResponse = await fetch(`${bridge.baseUrl}/`);
    assert.equal(consoleResponse.status, 200);
    const consoleHtml = await consoleResponse.text();
    assert.match(consoleHtml, /Bridge 调试控制台/);
    assert.match(consoleHtml, /event-alert/);

    const snapshotResponse = await fetch(`${bridge.baseUrl}/api/debug/snapshot`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as {
      bridge: { ok: boolean };
      workbuddy: { projects: unknown[] };
      xiaozhi: { state: string; mcp: { configured: boolean; state: string } };
    };
    assert.equal(snapshot.bridge.ok, true);
    assert.equal(snapshot.workbuddy.projects.length, 3);
    assert.equal(snapshot.xiaozhi.state, "idle");
    assert.equal(snapshot.xiaozhi.mcp.configured, false);
    assert.equal(snapshot.xiaozhi.mcp.state, "disabled");

    const probeResponse = await fetch(`${bridge.baseUrl}/api/debug/mcp-probe`, { method: "POST" });
    assert.equal(probeResponse.status, 200);
    const probe = await probeResponse.json() as { ok: boolean; toolCount: number };
    assert.equal(probe.ok, true);
    assert.equal(probe.toolCount, 12);
  } finally {
    await bridge.close();
  }
});
