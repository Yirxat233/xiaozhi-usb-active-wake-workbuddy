import { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { BridgeRuntime } from "./bridge.js";
import type { XiaozhiMcpStatus } from "./xiaozhi-mcp-connector.js";

const jsonResult = (message: string, data: unknown) => ({
  content: [{ type: "text" as const, text: message }],
  structuredContent: { data } as Record<string, unknown>,
});

const errorResult = (error: unknown) => ({
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  isError: true,
});

const safely = <TArgs extends unknown[]>(handler: (...args: TArgs) => Promise<ReturnType<typeof jsonResult>>) =>
  async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };

export function createBridgeMcpServer(
  runtime: BridgeRuntime,
  options: { getXiaozhiMcpStatus?: () => XiaozhiMcpStatus } = {},
): McpServer {
  const server = new McpServer(
    { name: "xiaozhi-workbuddy-bridge", version: "0.1.0" },
    {
      instructions:
        "用于通过小智语音控制 WorkBuddy 项目。项目状态变化会自动进入小智主动播报队列。用户回答刚才的 WorkBuddy 提问时，先查询 workbuddy_list_pending_questions，再用 workbuddy_reply_to_question 将回答交回同一项目。",
    },
  );

  server.registerTool(
    "xiaozhi_speak",
    {
      description: "通过 USB 把通知交给官方小智会话，并由小智主动语音回复。设备忙碌时返回未接受。",
      inputSchema: z.object({ text: z.string().trim().min(1).max(600).describe("要播报的中文通知") }),
    },
    safely(async ({ text }) => {
      const accepted = await runtime.xiaozhi.speak({ type: "speak_request", session_id: randomUUID(),
        event_id: randomUUID(), event_type: "result", text });
      return jsonResult(accepted ? "小智已完成官方会话回复" : "设备未接受消息，请查看连接状态或稍后重试", { accepted });
    }),
  );

  server.registerTool(
    "workbuddy_list_projects",
    {
      description: "查询 WorkBuddy 项目列表，可按最近天数和状态过滤",
      inputSchema: z.object({
        recent_days: z.number().int().positive().optional().describe("只返回最近 N 天更新的项目"),
        status: z.enum(["idle", "running", "waiting_input", "completed", "failed"]).optional(),
      }),
    },
    safely(async ({ recent_days, status }) => {
      const projects = await runtime.workbuddy.listProjects({ recentDays: recent_days, status });
      const summary = projects.length
        ? `找到${projects.length}个项目：${projects.map((item) => item.name).join("、")}。`
        : "没有找到符合条件的项目。";
      return jsonResult(summary, projects);
    }),
  );

  server.registerTool(
    "workbuddy_create_project",
    {
      description: "在 WorkBuddy 项目根目录新建项目，并立即创建桌面可见任务来执行首条指令",
      inputSchema: z.object({
        name: z.string().min(1).describe("新项目名称，不要包含路径分隔符"),
        instruction: z.string().optional().describe("创建后立即交给 WorkBuddy 执行的首条指令"),
      }),
    },
    safely(async ({ name, instruction }) => {
      const firstInstruction = instruction?.trim()
        || "请确认这个新项目已经建立并等待下一步指令。只做简短回复，不要修改文件。";
      const project = await runtime.workbuddy.createProject(name, firstInstruction);
      return jsonResult(`项目“${project.name}”已经创建，并已把首条指令提交到 WorkBuddy。`, project);
    }),
  );

  server.registerTool(
    "workbuddy_open_project",
    {
      description: "根据名称、描述或 ID 模糊匹配并打开 WorkBuddy 项目；如果用户同时要求做事，必须把要求放入 instruction",
      inputSchema: z.object({
        query: z.string().min(1),
        instruction: z.string().optional().describe("打开后立即发送给 WorkBuddy 的具体任务指令"),
      }),
    },
    safely(async ({ query, instruction }) => {
      let project = await runtime.workbuddy.openProject(query);
      if (instruction?.trim()) {
        project = await runtime.workbuddy.continueProject(project.id, instruction.trim());
        return jsonResult(`已经打开项目“${project.name}”，并把指令提交到 WorkBuddy。`, project);
      }
      return jsonResult(`已经打开项目“${project.name}”。如需执行任务，请继续调用 workbuddy_continue_project。`, project);
    }),
  );

  server.registerTool(
    "workbuddy_get_project_status",
    {
      description: "获取指定项目或当前已打开项目的状态",
      inputSchema: z.object({ project_id: z.string().optional() }),
    },
    safely(async ({ project_id }) => {
      const project = await runtime.workbuddy.getProject(project_id);
      return jsonResult(
        `项目“${project.name}”当前状态为${project.status}，进度${project.progress}%。${project.lastMessage ?? ""}`,
        project,
      );
    }),
  );

  server.registerTool(
    "workbuddy_continue_project",
    {
      description: "继续执行指定项目或当前已打开项目",
      inputSchema: z.object({
        project_id: z.string().optional(),
        instruction: z.string().optional(),
      }),
    },
    safely(async ({ project_id, instruction }) => {
      const project = await runtime.workbuddy.continueProject(project_id, instruction);
      return jsonResult(`项目“${project.name}”已经继续执行。`, project);
    }),
  );

  server.registerTool(
    "workbuddy_reply_to_question",
    {
      description: "回答 WorkBuddy 项目执行过程中提出的问题",
      inputSchema: z.object({ project_id: z.string().min(1), answer: z.string().min(1) }),
    },
    safely(async ({ project_id, answer }) => {
      const project = await runtime.workbuddy.replyToQuestion(project_id, answer);
      runtime.xiaozhi.setState("idle");
      return jsonResult(`回答已提交，项目“${project.name}”继续执行。`, project);
    }),
  );

  server.registerTool(
    "workbuddy_list_pending_questions",
    {
      description: "列出等待用户回答的项目问题",
      inputSchema: z.object({}),
    },
    safely(async () => {
      const projects = await runtime.workbuddy.listPendingQuestions();
      return jsonResult(
        projects.length ? `有${projects.length}个项目等待回答。` : "当前没有待回答问题。",
        projects,
      );
    }),
  );

  server.registerTool(
    "workbuddy_get_recent_events",
    {
      description: "查询最近的进度、问题、结果和错误事件",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    },
    safely(async ({ limit }) => {
      const events = await runtime.workbuddy.getRecentEvents(limit);
      return jsonResult(`返回${events.length}条事件。`, events);
    }),
  );

  server.registerTool(
    "workbuddy_list_sessions",
    {
      description: "查询真实 WorkBuddy 项目的历史 Session、标题、最近回复和当前恢复映射",
      inputSchema: z.object({ project_id: z.string().optional() }),
    },
    safely(async ({ project_id }) => {
      const sessions = await runtime.workbuddy.listSessions?.(project_id) ?? [];
      return jsonResult(
        sessions.length ? `找到${sessions.length}条历史 Session。` : "当前 Adapter 没有可用的历史 Session。",
        sessions,
      );
    }),
  );

  server.registerTool(
    "xiaozhi_bridge_status",
    {
      description: "查看小智 MCP 云端连接、设备状态、待播报队列和主动播报记录",
      inputSchema: z.object({}),
    },
    safely(async () => {
      const data = {
        ...runtime.dispatcher.snapshot(),
        mcpCloud: options.getXiaozhiMcpStatus?.(),
        notifications: runtime.xiaozhi.getRecords(),
      };
      return jsonResult(`设备状态${data.deviceState}，待播报${data.queued}条。`, data);
    }),
  );

  return server;
}
