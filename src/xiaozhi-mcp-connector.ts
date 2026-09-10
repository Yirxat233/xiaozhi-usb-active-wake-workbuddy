import type { JSONRPCMessage, Transport, TransportSendOptions } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import WebSocket, { type RawData } from "ws";

export type XiaozhiMcpConnectionState = "disabled" | "connecting" | "connected" | "reconnecting" | "stopped";

export interface XiaozhiMcpStatus {
  configured: boolean;
  connected: boolean;
  state: XiaozhiMcpConnectionState;
  endpoint: string;
  connectedAt?: string;
  lastMessageAt?: string;
  nextRetryAt?: string;
  reconnectAttempt: number;
  disconnectCount: number;
  messageCount: number;
  toolCallCount: number;
  lastError?: string;
}

interface CloseDetails {
  code: number;
  reason: string;
}

const endpointLabel = (endpoint?: string): string => {
  if (!endpoint) return "未配置";
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "无效地址";
  }
};

const safeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&]token=)[^\s&]+/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_.-]+/g, "[REDACTED_TOKEN]");
};

const rawDataToString = (data: RawData): string => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
};

export class XiaozhiWebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private socket?: WebSocket;
  private started = false;
  private closed = false;
  private resolveClosed!: (details: CloseDetails) => void;
  private readonly closedPromise = new Promise<CloseDetails>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly endpoint: string,
    private readonly onInbound?: (message: JSONRPCMessage) => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("小智 MCP WebSocket transport 已启动");
    this.started = true;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint);
      this.socket = socket;
      let opened = false;
      let settled = false;

      socket.once("open", () => {
        opened = true;
        settled = true;
        resolve();
      });

      socket.on("message", (data) => {
        try {
          const message = JSON.parse(rawDataToString(data)) as JSONRPCMessage;
          this.onInbound?.(message);
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(new Error(`小智 MCP 消息解析失败：${safeError(error)}`));
        }
      });

      socket.on("error", (error) => {
        const normalized = new Error(`小智 MCP WebSocket 错误：${safeError(error)}`);
        this.onerror?.(normalized);
        if (!opened && !settled) {
          settled = true;
          reject(normalized);
        }
      });

      socket.once("close", (code, reasonBuffer) => {
        const reason = reasonBuffer.toString("utf8");
        this.finishClose({ code, reason });
        if (!opened && !settled) {
          settled = true;
          reject(new Error(`小智 MCP WebSocket 在握手前关闭（${code}${reason ? `：${reason}` : ""}）`));
        }
      });
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("小智 MCP WebSocket 尚未连接");
    }
    await new Promise<void>((resolve, reject) => {
      // 官方 mcp_pipe 会保留 stdio 的换行；JSON 尾部空白同时兼容标准 JSON-RPC。
      this.socket!.send(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      this.finishClose({ code: 1000, reason: "closed before start" });
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000, "bridge shutdown");
    else if (socket.readyState === WebSocket.CLOSED) this.finishClose({ code: 1000, reason: "closed" });
    await this.closedPromise;
  }

  waitUntilClosed(): Promise<CloseDetails> {
    return this.closedPromise;
  }

  private finishClose(details: CloseDetails): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed(details);
    this.onclose?.();
  }
}

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, milliseconds);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

export class XiaozhiMcpConnector {
  private abortController = new AbortController();
  private loopPromise?: Promise<void>;
  private activeTransport?: XiaozhiWebSocketTransport;
  private activeServer?: McpServer;
  private stopped = false;
  private status: XiaozhiMcpStatus;

  constructor(
    private endpoint: string | undefined,
    private readonly createServer: () => McpServer,
    private readonly reconnectInitialMs = 1_000,
    private readonly reconnectMaxMs = 60_000,
  ) {
    this.status = {
      configured: Boolean(endpoint),
      connected: false,
      state: endpoint ? "connecting" : "disabled",
      endpoint: endpointLabel(endpoint),
      reconnectAttempt: 0,
      disconnectCount: 0,
      messageCount: 0,
      toolCallCount: 0,
    };
  }

  start(): void {
    if (!this.endpoint || this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.run();
  }

  async configure(endpoint: string): Promise<XiaozhiMcpStatus> {
    const normalized = normalizeEndpoint(endpoint);
    await this.stopLoop();
    this.endpoint = normalized;
    this.abortController = new AbortController();
    this.stopped = false;
    this.status = {
      configured: true,
      connected: false,
      state: "connecting",
      endpoint: endpointLabel(normalized),
      reconnectAttempt: 0,
      disconnectCount: 0,
      messageCount: 0,
      toolCallCount: 0,
    };
    this.start();
    return this.getStatus();
  }

  async disable(): Promise<XiaozhiMcpStatus> {
    await this.stopLoop();
    this.endpoint = undefined;
    this.status = {
      configured: false,
      connected: false,
      state: "disabled",
      endpoint: "未配置",
      reconnectAttempt: 0,
      disconnectCount: this.status.disconnectCount,
      messageCount: this.status.messageCount,
      toolCallCount: this.status.toolCallCount,
    };
    return this.getStatus();
  }

  getStatus(): XiaozhiMcpStatus {
    return { ...this.status };
  }

  async close(): Promise<void> {
    await this.stopLoop();
    this.status = { ...this.status, connected: false, state: "stopped", nextRetryAt: undefined };
  }

  private async stopLoop(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    await this.activeTransport?.close().catch(() => undefined);
    await this.activeServer?.close().catch(() => undefined);
    await this.loopPromise?.catch(() => undefined);
    this.activeTransport = undefined;
    this.activeServer = undefined;
    this.loopPromise = undefined;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && this.endpoint) {
      this.status = {
        ...this.status,
        connected: false,
        state: attempt === 0 ? "connecting" : "reconnecting",
        reconnectAttempt: attempt,
        nextRetryAt: undefined,
      };

      const transport = new XiaozhiWebSocketTransport(this.endpoint, (message) => this.recordInbound(message));
      const server = this.createServer();
      this.activeTransport = transport;
      this.activeServer = server;

      try {
        await server.connect(transport);
        if (this.stopped) break;
        attempt = 0;
        this.status = {
          ...this.status,
          connected: true,
          state: "connected",
          connectedAt: new Date().toISOString(),
          reconnectAttempt: 0,
          lastError: undefined,
        };

        const closed = await transport.waitUntilClosed();
        if (this.stopped) break;
        this.status.disconnectCount += 1;
        this.status.lastError = `云端关闭连接（${closed.code}${closed.reason ? `：${safeError(closed.reason)}` : ""}）`;
      } catch (error) {
        if (!this.stopped) this.status.lastError = safeError(error);
      } finally {
        this.activeTransport = undefined;
        this.activeServer = undefined;
        await server.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }

      if (this.stopped) break;
      attempt += 1;
      const backoff = Math.min(this.reconnectInitialMs * 2 ** (attempt - 1), this.reconnectMaxMs);
      this.status = {
        ...this.status,
        connected: false,
        state: "reconnecting",
        reconnectAttempt: attempt,
        nextRetryAt: new Date(Date.now() + backoff).toISOString(),
      };
      await delay(backoff, this.abortController.signal);
    }
  }

  private recordInbound(message: JSONRPCMessage): void {
    this.status.messageCount += 1;
    this.status.lastMessageAt = new Date().toISOString();
    if ("method" in message && message.method === "tools/call") this.status.toolCallCount += 1;
  }
}

function normalizeEndpoint(raw: string): string {
  const value = raw.trim().replace(/^wss\\:\/\//i, "wss://").replace(/^ws\\:\/\//i, "ws://");
  if (!value || value.length > 4_096) throw new Error("小智 MCP 地址无效");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("小智 MCP 地址格式无效");
  }
  const isLoopbackWs = url.protocol === "ws:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const isOfficial = url.protocol === "wss:" && url.hostname === "api.xiaozhi.me" && url.pathname.replace(/\/+$/, "") === "/mcp";
  if (!isOfficial && !isLoopbackWs) throw new Error("仅允许小智官方 wss://api.xiaozhi.me/mcp/ 或本机测试地址");
  if (isOfficial && !url.searchParams.get("token")) throw new Error("小智 MCP 地址缺少 token");
  url.hash = "";
  return url.toString();
}
