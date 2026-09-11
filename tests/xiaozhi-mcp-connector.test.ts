import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { BridgeRuntime } from "../src/bridge.js";
import { createBridgeMcpServer } from "../src/mcp-server.js";
import { XiaozhiMcpConnector } from "../src/xiaozhi-mcp-connector.js";

const withTimeout = <T>(promise: Promise<T>, milliseconds = 3_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("等待 WebSocket MCP 响应超时")), milliseconds);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

test("Xiaozhi WebSocket connector serves bridge MCP tools and records calls", async () => {
  const cloud = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => cloud.once("listening", resolve));
  const address = cloud.address();
  if (!address || typeof address === "string") throw new Error("测试 WebSocket 地址异常");

  const toolResult = new Promise<Record<string, unknown>>((resolve, reject) => {
    cloud.once("connection", (socket) => {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "xiaozhi-cloud-test", version: "1.0.0" },
        },
      }));

      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.id === 1) {
            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
          } else if (message.id === 2) {
            const result = message.result as { tools?: Array<{ name?: string }> };
            assert.ok(result.tools?.some((tool) => tool.name === "workbuddy_continue_project"));
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "workbuddy_list_projects", arguments: { recent_days: 3 } },
            }));
          } else if (message.id === 3) {
            resolve(message);
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  const runtime = new BridgeRuntime({ stepDelayMs: 10 });
  const connector = new XiaozhiMcpConnector(
    undefined,
    () => createBridgeMcpServer(runtime),
    10,
    50,
  );

  try {
    assert.equal(connector.getStatus().state, "disabled");
    await connector.configure(`ws://127.0.0.1:${address.port}`);
    const response = await withTimeout(toolResult);
    assert.ok(response.result);
    assert.equal(connector.getStatus().connected, true);
    assert.equal(connector.getStatus().toolCallCount, 1);
    assert.equal(connector.getStatus().messageCount, 4);
    assert.equal(connector.getStatus().lastToolName, "workbuddy_list_projects");
    assert.deepEqual(connector.getStatus().recentToolNames, ["workbuddy_list_projects"]);
    assert.ok(connector.getStatus().lastToolCallAt);
    await connector.disable();
    assert.equal(connector.getStatus().state, "disabled");
  } finally {
    await connector.close();
    runtime.close();
    await new Promise<void>((resolve, reject) => cloud.close((error) => error ? reject(error) : resolve()));
  }
});
