import type { Project, WorkBuddyAdapter, XiaozhiNotifier } from "./domain.js";
import { CodeBuddyCliAdapter } from "./codebuddy-cli-adapter.js";
import { MockWorkBuddyAdapter } from "./mock-workbuddy.js";
import { MockXiaozhiNotifier } from "./mock-xiaozhi.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";

const cleanInstruction = (value?: string): string | undefined => {
  const cleaned = value?.trim().replace(/^(?:执行|发送)(?:任务|指令)?\s*[:：]?\s*/, "");
  return cleaned || undefined;
};

export class BridgeRuntime {
  readonly workbuddy: WorkBuddyAdapter;
  readonly xiaozhi: XiaozhiNotifier;
  readonly dispatcher: NotificationDispatcher;

  constructor(options: {
    xiaozhiNotifier?: XiaozhiNotifier;
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
  } = {}) {
    this.workbuddy = options.adapter === "codebuddy"
      ? new CodeBuddyCliAdapter({
          cwd: options.workbuddyCwd ?? process.cwd(),
          projectRoots: options.workbuddyProjectRoots,
          sessionRoot: options.workbuddySessionRoot,
          configDir: options.workbuddyConfigDir,
          stateFile: options.workbuddyStateFile,
          cliScript: options.codebuddyCliScript,
          desktopTransport: options.workbuddyDesktopTransport,
          desktopTimeoutMs: options.workbuddyDesktopTimeoutMs,
          permissionMode: (process.env.WORKBUDDY_PERMISSION_MODE as "default" | "acceptEdits" | "auto" | "dontAsk" | "plan" | undefined) ?? "default",
          tools: process.env.WORKBUDDY_TOOLS ?? "default",
          maxTurns: Number(process.env.WORKBUDDY_MAX_TURNS ?? 8),
        })
      : new MockWorkBuddyAdapter(options.stepDelayMs);
    this.xiaozhi = options.xiaozhiNotifier ?? new MockXiaozhiNotifier();
    this.dispatcher = new NotificationDispatcher(this.workbuddy, this.xiaozhi);
  }

  async voiceCommand(text: string): Promise<{ reply: string; data?: Project | Project[] }> {
    const command = text.trim();
    if (/近三天|最近三天/.test(command) && /项目/.test(command)) {
      const projects = await this.workbuddy.listProjects({ recentDays: 3 });
      return {
        reply: projects.length
          ? `近三天共有${projects.length}个项目：${projects.map((item) => item.name).join("、")}。`
          : "近三天没有项目。",
        data: projects,
      };
    }

    const createMatch = command.match(/(?:新建|创建)(?:一个)?(?:名为|叫做?|名称为)?\s*(.+?)项目(?:[，,。；;]?\s*(?:并|然后)?\s*(.+))?$/)
      ?? command.match(/(?:新建|创建)(?:一个)?项目(?:名为|叫做?|名称为)?\s*([^，,。；;]+)(?:[，,。；;]\s*(.+))?$/);
    if (createMatch?.[1]) {
      const instruction = cleanInstruction(createMatch[2])
        ?? "请确认这个新项目已经建立并等待下一步指令。只做简短回复，不要修改文件。";
      const project = await this.workbuddy.createProject(createMatch[1].trim(), instruction);
      return { reply: `项目“${project.name}”已经创建，首条指令已提交到 WorkBuddy。`, data: project };
    }

    const openMatch = command.match(/(?:打开|开启)\s*(.+?)项目(?:[，,。；;]?\s*(?:并|然后)\s*(.+))?$/)
      ?? command.match(/(?:打开|开启)\s*(.+)$/);
    if (openMatch?.[1]) {
      let project = await this.workbuddy.openProject(openMatch[1].trim());
      const instruction = cleanInstruction(openMatch[2]);
      if (instruction) {
        project = await this.workbuddy.continueProject(project.id, instruction);
        return { reply: `已经打开项目“${project.name}”，并把指令提交到 WorkBuddy。`, data: project };
      }
      return { reply: `已经打开项目“${project.name}”。`, data: project };
    }

    const pending = await this.workbuddy.listPendingQuestions();
    if (pending.length === 1) {
      const project = await this.workbuddy.replyToQuestion(pending[0]!.id, command);
      this.xiaozhi.setState("idle");
      return { reply: `已把回答交给项目“${project.name}”。`, data: project };
    }

    if (/继续/.test(command)) {
      const project = await this.workbuddy.continueProject(undefined, command);
      return { reply: `项目“${project.name}”已经继续执行。`, data: project };
    }

    return { reply: "我没识别这个命令，可以查询近三天项目、打开项目或继续项目。" };
  }

  close(): void {
    this.dispatcher.close();
    this.xiaozhi.close?.();
  }
}
