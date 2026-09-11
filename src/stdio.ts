import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { BridgeRuntime } from "./bridge.js";
import { createBridgeMcpServer } from "./mcp-server.js";
import { UsbXiaozhiNotifier } from "./usb-xiaozhi.js";

const runtime = new BridgeRuntime({
  stepDelayMs: Number(process.env.MOCK_STEP_DELAY_MS ?? 250),
  adapter: process.env.WORKBUDDY_ADAPTER === "codebuddy" ? "codebuddy" : "mock",
  workbuddyCwd: process.env.WORKBUDDY_CWD,
  workbuddyProjectRoots: process.env.WORKBUDDY_PROJECT_ROOTS?.split(";").filter(Boolean),
  workbuddySessionRoot: process.env.WORKBUDDY_SESSION_ROOT,
  workbuddyConfigDir: process.env.WORKBUDDY_CONFIG_DIR,
  workbuddyStateFile: process.env.WORKBUDDY_STATE_FILE,
  notificationQueueFile: process.env.NOTIFICATION_QUEUE_FILE,
  codebuddyCliScript: process.env.CODEBUDDY_CLI_SCRIPT,
  workbuddyDesktopTransport: process.env.WORKBUDDY_TRANSPORT as "auto" | "desktop" | "cli" | undefined,
  xiaozhiNotifier: process.env.XIAOZHI_NOTIFIER === "usb" ? new UsbXiaozhiNotifier() : undefined,
});
const server = createBridgeMcpServer(runtime);
const transport = new StdioServerTransport();

await server.connect(transport);

const shutdown = async () => {
  runtime.close();
  await server.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
