import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { BridgeRuntime } from "./bridge.js";
import { createBridgeMcpServer } from "./mcp-server.js";
import type { DeviceState, XiaozhiNotifier } from "./domain.js";
import { UsbXiaozhiNotifier } from "./usb-xiaozhi.js";
import { XiaozhiMcpConnector } from "./xiaozhi-mcp-connector.js";

export interface BridgeServerHandle {
  runtime: BridgeRuntime;
  xiaozhiMcp: XiaozhiMcpConnector;
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("请求体超过 1MB 限制");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
};

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

const sendStatic = async (response: ServerResponse, pathname: string): Promise<boolean> => {
  const asset = staticFiles.get(pathname);
  if (!asset) return false;
  const content = await readFile(resolve(process.cwd(), "public", asset.file));
  response.writeHead(200, {
    "content-type": asset.type,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
  return true;
};

const probeMcp = async (baseUrl: string) => {
  const startedAt = performance.now();
  const client = new Client({ name: "bridge-web-console-probe", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const tools = await client.listTools();
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      protocolEra: client.getProtocolEra() ?? "legacy",
      server: client.getServerVersion(),
      toolCount: tools.tools.length,
      tools: tools.tools.map((tool) => tool.name),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
};

export async function startBridgeServer(options: {
  xiaozhiNotifier?: XiaozhiNotifier;
  host?: string;
  port?: number;
  stepDelayMs?: number;
  adapter?: "mock" | "codebuddy";
  workbuddyCwd?: string;
  workbuddyProjectRoots?: string[];
  workbuddySessionRoot?: string;
  workbuddyConfigDir?: string;
  workbuddyStateFile?: string;
  codebuddyCliScript?: string;
  workbuddyDesktopTransport?: "auto" | "desktop" | "cli";
  workbuddyDesktopTimeoutMs?: number;
  xiaozhiMcpEndpoint?: string;
  xiaozhiReconnectInitialMs?: number;
  xiaozhiReconnectMaxMs?: number;
} = {}): Promise<BridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const runtime = new BridgeRuntime({
    xiaozhiNotifier: options.xiaozhiNotifier,
    stepDelayMs: options.stepDelayMs,
    adapter: options.adapter,
    workbuddyCwd: options.workbuddyCwd,
    workbuddyProjectRoots: options.workbuddyProjectRoots,
    workbuddySessionRoot: options.workbuddySessionRoot,
    workbuddyConfigDir: options.workbuddyConfigDir,
    workbuddyStateFile: options.workbuddyStateFile,
    codebuddyCliScript: options.codebuddyCliScript,
    workbuddyDesktopTransport: options.workbuddyDesktopTransport,
    workbuddyDesktopTimeoutMs: options.workbuddyDesktopTimeoutMs,
  });
  let xiaozhiMcp!: XiaozhiMcpConnector;
  const createCloudMcpServer = () => createBridgeMcpServer(runtime, {
    getXiaozhiMcpStatus: () => xiaozhiMcp.getStatus(),
  });
  xiaozhiMcp = new XiaozhiMcpConnector(
    options.xiaozhiMcpEndpoint,
    createCloudMcpServer,
    options.xiaozhiReconnectInitialMs,
    options.xiaozhiReconnectMaxMs,
  );
  const mcpHandler = createMcpHandler(createCloudMcpServer);
  const handleMcp = toNodeHandler(mcpHandler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const startedAt = Date.now();
  let baseUrl = "";

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/mcp") {
        if (!validateHost(request, response) || !validateOrigin(request, response)) return;
        await handleMcp(request, response);
        return;
      }

      if (request.method === "GET" && await sendStatic(response, url.pathname)) return;

      if (request.method === "GET" && url.pathname === "/health") {
        const diagnostics = await runtime.workbuddy.diagnostics?.();
        sendJson(response, 200, {
          ok: true,
          adapter: diagnostics?.adapter ?? "unknown",
          workbuddy: diagnostics,
          deviceState: runtime.xiaozhi.getState(),
          notifier: runtime.xiaozhi instanceof UsbXiaozhiNotifier ? "usb" : "mock",
          notifierError: runtime.xiaozhi instanceof UsbXiaozhiNotifier ? runtime.xiaozhi.lastError : undefined,
          xiaozhiMcp: xiaozhiMcp.getStatus(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/debug/snapshot") {
        const [projects, sessions, events, pendingQuestions, workbuddyDiagnostics] = await Promise.all([
          runtime.workbuddy.listProjects(),
          runtime.workbuddy.listSessions?.() ?? Promise.resolve([]),
          runtime.workbuddy.getRecentEvents(50),
          runtime.workbuddy.listPendingQuestions(),
          runtime.workbuddy.diagnostics?.() ?? Promise.resolve({ adapter: "unknown", connected: false }),
        ]);
        sendJson(response, 200, {
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          bridge: {
            ok: true,
            adapter: workbuddyDiagnostics.adapter,
            baseUrl,
            mcpEndpoint: `${baseUrl}/mcp`,
          },
          workbuddy: {
            ok: workbuddyDiagnostics.connected,
            adapter: workbuddyDiagnostics.adapter,
            diagnostics: workbuddyDiagnostics,
            projects,
            sessions,
            pendingQuestions,
            events,
          },
          xiaozhi: {
            adapter: runtime.xiaozhi instanceof UsbXiaozhiNotifier ? "UsbXiaozhiNotifier" : "MockXiaozhiNotifier",
            state: runtime.xiaozhi.getState(),
            mcp: xiaozhiMcp.getStatus(),
            dispatcher: runtime.dispatcher.snapshot(),
            notifications: runtime.xiaozhi.getRecords(),
          },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/debug/mcp-probe") {
        sendJson(response, 200, await probeMcp(baseUrl));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/xiaozhi-mcp/connect") {
        const remote = request.socket.remoteAddress;
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          sendJson(response, 403, { error: "仅允许本机配置小智 MCP" });
          return;
        }
        const body = await readJson(request);
        if (typeof body.endpoint !== "string") throw new Error("endpoint 必须是字符串");
        sendJson(response, 200, await xiaozhiMcp.configure(body.endpoint));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/xiaozhi-mcp/disconnect") {
        const remote = request.socket.remoteAddress;
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          sendJson(response, 403, { error: "仅允许本机配置小智 MCP" });
          return;
        }
        sendJson(response, 200, await xiaozhiMcp.disable());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        const recentDays = url.searchParams.get("recentDays");
        sendJson(response, 200, await runtime.workbuddy.listProjects({
          recentDays: recentDays ? Number(recentDays) : undefined,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        sendJson(response, 200, await runtime.workbuddy.getRecentEvents(Number(url.searchParams.get("limit") ?? 20)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        sendJson(response, 200, await runtime.workbuddy.listSessions?.(projectId) ?? []);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/notifications") {
        sendJson(response, 200, runtime.xiaozhi.getRecords());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/speak") {
        const remote = request.socket.remoteAddress;
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          sendJson(response, 403, { error: "仅允许本机发起播报" });
          return;
        }
        const body = await readJson(request);
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 600) throw new Error("text 需要 1–600 个字符");
        const accepted = await runtime.xiaozhi.speak({ type: "speak_request", session_id: crypto.randomUUID(),
          event_id: crypto.randomUUID(), event_type: "result", text: body.text.trim() });
        sendJson(response, accepted ? 200 : 409, { accepted });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, runtime.dispatcher.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/voice") {
        const body = await readJson(request);
        if (typeof body.text !== "string" || !body.text.trim()) throw new Error("text 必须是非空字符串");
        sendJson(response, 200, await runtime.voiceCommand(body.text));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/mock/device-state") {
        if (runtime.xiaozhi instanceof UsbXiaozhiNotifier) throw new Error("真实设备状态不能通过模拟接口修改");
        const body = await readJson(request);
        const allowed: DeviceState[] = ["idle", "connecting", "speaking", "listening", "offline"];
        if (!allowed.includes(body.state as DeviceState)) throw new Error("无效的设备状态");
        runtime.xiaozhi.setState(body.state as DeviceState);
        sendJson(response, 200, { state: runtime.xiaozhi.getState() });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获取 Bridge 监听地址");
  baseUrl = `http://${host}:${address.port}`;
  xiaozhiMcp.start();

  return {
    runtime,
    xiaozhiMcp,
    server,
    baseUrl,
    async close() {
      await xiaozhiMcp.close();
      runtime.close();
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
