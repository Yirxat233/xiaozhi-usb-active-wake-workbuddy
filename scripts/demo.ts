import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startBridgeServer } from "../src/http-server.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const bridge = await startBridgeServer({ port: 0, stepDelayMs: 120 });
const client = new Client({ name: "bridge-demo", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp`));

try {
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find((item) => item.type === "text");
    console.log(`\n[${name}] ${text?.type === "text" ? text.text : ""}`);
    return result;
  };

  await call("workbuddy_list_projects", { recent_days: 3 });
  await call("workbuddy_open_project", { query: "Bridge" });
  await call("workbuddy_continue_project", { instruction: "继续完成 Mock 全链路验证" });
  await sleep(320);
  await call("workbuddy_list_pending_questions");
  await call("xiaozhi_bridge_status");
  await call("workbuddy_reply_to_question", { project_id: "voice-bridge", answer: "允许继续" });
  await sleep(180);
  await call("workbuddy_get_project_status", { project_id: "voice-bridge" });
  await call("xiaozhi_bridge_status");

  console.log("\nMock speak_request records:");
  for (const record of bridge.runtime.xiaozhi.getRecords()) {
    console.log(JSON.stringify(record, null, 2));
  }
} finally {
  await client.close();
  await bridge.close();
}
