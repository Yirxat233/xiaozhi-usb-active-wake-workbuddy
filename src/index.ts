import { startBridgeServer } from "./http-server.js";
import { UsbXiaozhiNotifier } from "./usb-xiaozhi.js";

const port = Number(process.env.BRIDGE_PORT ?? 8787);
const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
const stepDelayMs = Number(process.env.MOCK_STEP_DELAY_MS ?? 250);
const adapter = process.env.WORKBUDDY_ADAPTER === "codebuddy" ? "codebuddy" : "mock";
const projectRoots = process.env.WORKBUDDY_PROJECT_ROOTS?.split(";").map((item) => item.trim()).filter(Boolean);
const handle = await startBridgeServer({
  xiaozhiNotifier: process.env.XIAOZHI_NOTIFIER === "usb" ? new UsbXiaozhiNotifier() : undefined,
  host,
  port,
  stepDelayMs,
  adapter,
  workbuddyCwd: process.env.WORKBUDDY_CWD,
  workbuddyProjectRoots: projectRoots,
  workbuddySessionRoot: process.env.WORKBUDDY_SESSION_ROOT,
  workbuddyConfigDir: process.env.WORKBUDDY_CONFIG_DIR,
  workbuddyStateFile: process.env.WORKBUDDY_STATE_FILE,
  codebuddyCliScript: process.env.CODEBUDDY_CLI_SCRIPT,
  workbuddyDesktopTransport: process.env.WORKBUDDY_TRANSPORT as "auto" | "desktop" | "cli" | undefined,
  workbuddyDesktopTimeoutMs: process.env.WORKBUDDY_DESKTOP_TIMEOUT_MS
    ? Number(process.env.WORKBUDDY_DESKTOP_TIMEOUT_MS)
    : undefined,
  xiaozhiMcpEndpoint: process.env.XIAOZHI_MCP_ENDPOINT ?? process.env.MCP_ENDPOINT,
  xiaozhiReconnectInitialMs: process.env.XIAOZHI_MCP_RECONNECT_INITIAL_MS
    ? Number(process.env.XIAOZHI_MCP_RECONNECT_INITIAL_MS)
    : undefined,
  xiaozhiReconnectMaxMs: process.env.XIAOZHI_MCP_RECONNECT_MAX_MS
    ? Number(process.env.XIAOZHI_MCP_RECONNECT_MAX_MS)
    : undefined,
});

console.log(`Xiaozhi WorkBuddy Bridge: ${handle.baseUrl}`);
console.log(`WorkBuddy adapter:         ${adapter}`);
console.log(`Web debug console:         ${handle.baseUrl}/`);
console.log(`MCP Streamable HTTP:       ${handle.baseUrl}/mcp`);
console.log(`Xiaozhi MCP cloud:         ${handle.xiaozhiMcp.getStatus().configured ? "connecting" : "disabled"}`);
console.log(`Voice endpoint:            ${handle.baseUrl}/api/voice`);

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
