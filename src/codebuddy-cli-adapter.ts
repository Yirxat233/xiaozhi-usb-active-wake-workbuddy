import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  ListProjectsFilter,
  Project,
  WorkBuddyAdapter,
  WorkBuddyDiagnostics,
  WorkBuddyEvent,
  WorkBuddyEventType,
  WorkBuddySession,
} from "./domain.js";

export interface CodeBuddyCliOptions {
  cwd: string;
  projectRoots?: string[];
  sessionRoot?: string;
  configDir?: string;
  stateFile?: string;
  cliScript?: string;
  desktopHelperScript?: string;
  desktopTransport?: "auto" | "desktop" | "cli";
  desktopReveal?: boolean;
  desktopPollIntervalMs?: number;
  desktopTimeoutMs?: number;
  permissionMode?: "default" | "acceptEdits" | "auto" | "dontAsk" | "plan";
  tools?: string;
  maxTurns?: number;
}

type StreamMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
  event?: { type?: string; content_block?: { type?: string; name?: string; input?: unknown } };
};

type SessionLogEntry = {
  id?: string;
  parentId?: string;
  type?: string;
  role?: string;
  status?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  timestamp?: string | number;
  aiTitle?: string;
  content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
};

type PersistedState = {
  version: 1;
  activeProjectId?: string;
  projects: Record<string, { cwd: string; latestSessionId?: string }>;
};

type ProjectRecord = { project: Project; sessionId?: string };

const clone = <T>(value: T): T => structuredClone(value);
const pathKey = (value: string): string => resolve(value).replaceAll("\\", "/").toLocaleLowerCase();
const projectIdFor = (cwd: string): string => `wb-${createHash("sha256").update(pathKey(cwd)).digest("hex").slice(0, 12)}`;
const asIso = (value: string | number | undefined, fallback: Date): string => {
  const parsed = value === undefined ? Number.NaN : typeof value === "number" ? value : Date.parse(value);
  return new Date(Number.isFinite(parsed) ? parsed : fallback.getTime()).toISOString();
};
const textFromContent = (content: SessionLogEntry["content"]): string | undefined => {
  const text = content?.map((item) => item.text ?? "").join("").trim();
  return text || undefined;
};

export class CodeBuddyCliAdapter implements WorkBuddyAdapter {
  private readonly emitter = new EventEmitter();
  private readonly events: WorkBuddyEvent[] = [];
  private readonly cliScript: string;
  private readonly projectRoots: string[];
  private readonly sessionRoot: string;
  private readonly configDir: string;
  private readonly stateFile: string;
  private readonly desktopTransport: "auto" | "desktop" | "cli";
  private readonly desktopReveal: boolean;
  private readonly projects = new Map<string, ProjectRecord>();
  private sessions: WorkBuddySession[] = [];
  private activeProjectId?: string;
  private runningProjectId?: string;
  private lastError?: string;
  private persistenceError?: string;
  private versionCache?: string;
  private desktopRunningCache?: { checkedAt: number; value: boolean };
  private persistedState: PersistedState = { version: 1, projects: {} };
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor(private readonly options: CodeBuddyCliOptions) {
    const userProfile = process.env.USERPROFILE ?? process.cwd();
    const localAppData = process.env.LOCALAPPDATA;
    this.cliScript = options.cliScript ?? join(
      localAppData ?? "", "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "dist", "codebuddy.js",
    );
    this.projectRoots = [...new Set((options.projectRoots?.length ? options.projectRoots : [join(userProfile, "WorkBuddy")]).map((root) => resolve(root)))];
    this.configDir = resolve(options.configDir ?? (options.sessionRoot ? dirname(options.sessionRoot) : join(userProfile, ".workbuddy")));
    this.sessionRoot = resolve(options.sessionRoot ?? join(this.configDir, "projects"));
    this.stateFile = resolve(options.stateFile ?? join(process.cwd(), "data", "workbuddy-state.json"));
    this.desktopTransport = options.desktopTransport
      ?? (process.platform === "win32" && pathKey(this.sessionRoot).includes("/.workbuddy/projects") ? "auto" : "cli");
    this.desktopReveal = options.desktopReveal ?? true;
    this.ready = this.initialize();
  }

  async listProjects(filter: ListProjectsFilter = {}): Promise<Project[]> {
    await this.ready;
    await this.discover();
    return [...this.projects.values()]
      .map((record) => record.project)
      .filter((project) => !filter.status || filter.status === project.status)
      .filter((project) => !filter.recentDays || Date.parse(project.updatedAt) >= Date.now() - filter.recentDays * 86_400_000)
      .sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(clone);
  }

  async createProject(name: string, instruction?: string): Promise<Project> {
    await this.ready;
    const projectName = name.trim().replace(/[. ]+$/g, "");
    if (!projectName) throw new Error("项目名称不能为空");
    if (/[<>:\"/\\|?*]/.test(projectName) || projectName === "." || projectName === "..") {
      throw new Error("项目名称包含 Windows 路径不支持的字符");
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(projectName)) {
      throw new Error("项目名称是 Windows 保留名称");
    }

    const root = this.projectRoots[0]!;
    await mkdir(root, { recursive: true });
    const cwd = resolve(root, projectName);
    if (pathKey(dirname(cwd)) !== pathKey(root)) throw new Error("项目必须创建在 WorkBuddy 项目根目录下");
    try {
      await mkdir(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await this.isDirectory(cwd)) throw error;
    }

    await this.discover();
    const record = this.projects.get(projectIdFor(cwd));
    if (!record) throw new Error(`已创建目录但无法发现 WorkBuddy 项目：${cwd}`);
    this.setActiveProject(record.project.id);
    record.project.lastMessage = record.sessionId ? "项目已存在，已恢复最近任务" : "项目目录已创建，等待建立首个任务";
    this.touch(record.project);
    await this.persistState();
    return instruction?.trim() ? this.continueProject(record.project.id, instruction.trim()) : clone(record.project);
  }

  async openProject(query: string): Promise<Project> {
    await this.ready;
    await this.discover();
    const needle = query.trim().toLocaleLowerCase();
    const matches = [...this.projects.values()].filter(({ project }) =>
      `${project.id} ${project.name} ${project.description} ${project.cwd ?? ""}`.toLocaleLowerCase().includes(needle));
    if (!matches.length) throw new Error(`没有找到匹配“${query}”的真实 WorkBuddy 项目`);
    const exact = matches.find(({ project }) => project.id.toLocaleLowerCase() === needle || project.name.toLocaleLowerCase() === needle);
    const record = exact ?? matches.sort((a, b) => Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt))[0]!;
    this.setActiveProject(record.project.id);
    record.project.lastMessage = record.sessionId ? `已打开并映射历史会话 ${record.sessionId}` : "已打开项目，尚无历史会话";
    this.touch(record.project);
    await this.persistState();
    return clone(record.project);
  }

  async getProject(projectId?: string): Promise<Project> {
    await this.ready;
    return clone(this.requireProject(projectId).project);
  }

  async continueProject(projectId?: string, instruction = "继续之前的项目进度"): Promise<Project> {
    await this.ready;
    const record = this.requireProject(projectId);
    if (this.runningProjectId) throw new Error(`WorkBuddy 当前正在执行项目 ${this.runningProjectId}`);
    this.setActiveProject(record.project.id);
    this.runningProjectId = record.project.id;
    this.lastError = undefined;
    record.project.status = "running";
    record.project.progress = 10;
    record.project.pendingQuestion = undefined;
    record.project.lastMessage = `已提交到真实 WorkBuddy：${instruction}`;
    this.touch(record.project);
    await this.persistState();
    this.emit(record.project, "progress", record.sessionId ? `正在恢复历史会话 ${record.sessionId}。` : "任务已经提交到真实 WorkBuddy，正在建立新 Agent 会话。");
    void this.runAgent(record, instruction);
    return clone(record.project);
  }

  async replyToQuestion(projectId: string, answer: string): Promise<Project> {
    await this.ready;
    const record = this.requireProject(projectId);
    if (record.project.status !== "waiting_input") throw new Error("当前没有待回答问题");
    record.project.pendingQuestion = undefined;
    record.project.status = "idle";
    return this.continueProject(projectId, `用户对上一个问题的回答是：${answer}`);
  }

  async listPendingQuestions(): Promise<Project[]> {
    await this.ready;
    return [...this.projects.values()].filter(({ project }) => project.status === "waiting_input").map(({ project }) => clone(project));
  }

  async listSessions(projectId?: string): Promise<WorkBuddySession[]> {
    await this.ready;
    await this.discover();
    const selectedId = projectId;
    if (projectId) this.requireProject(projectId);
    return this.sessions
      .filter((session) => !selectedId || session.projectId === selectedId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((session) => clone({
        ...session,
        active: session.projectId === this.activeProjectId && session.id === this.projects.get(session.projectId)?.sessionId,
      }));
  }

  async getRecentEvents(limit = 20): Promise<WorkBuddyEvent[]> {
    await this.ready;
    return this.events.slice(-limit).reverse().map(clone);
  }

  subscribe(listener: (event: WorkBuddyEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async diagnostics(): Promise<WorkBuddyDiagnostics> {
    await this.ready;
    try {
      await access(this.cliScript);
      const desktopRunning = this.desktopTransport === "cli" ? undefined : await this.isWorkBuddyDesktopRunning();
      if (this.desktopTransport === "desktop" && !desktopRunning) throw new Error("WorkBuddy 桌面程序未运行");
      const version = this.versionCache ?? await this.readVersion();
      this.versionCache = version;
      const active = this.activeProjectId ? this.projects.get(this.activeProjectId) : undefined;
      return {
        adapter: "CodeBuddyCliAdapter",
        connected: true,
        version,
        cwd: active?.project.cwd,
        sessionId: active?.sessionId,
        running: Boolean(this.runningProjectId),
        projectCount: this.projects.size,
        sessionCount: this.sessions.length,
        activeProjectId: this.activeProjectId,
        stateFile: this.stateFile,
        sessionRoot: this.sessionRoot,
        configDir: this.configDir,
        transport: this.desktopTransport === "cli" ? "cli" : "cli+desktop-reveal",
        desktopRunning,
        persistenceError: this.persistenceError,
        error: this.lastError,
      };
    } catch (error) {
      return {
        adapter: "CodeBuddyCliAdapter",
        connected: false,
        cwd: this.activeProjectId ? this.projects.get(this.activeProjectId)?.project.cwd : this.options.cwd,
        running: Boolean(this.runningProjectId),
        projectCount: this.projects.size,
        sessionCount: this.sessions.length,
        activeProjectId: this.activeProjectId,
        stateFile: this.stateFile,
        sessionRoot: this.sessionRoot,
        configDir: this.configDir,
        transport: this.desktopTransport === "cli" ? "cli" : "cli+desktop-reveal",
        desktopRunning: this.desktopTransport === "cli" ? undefined : false,
        persistenceError: this.persistenceError,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async initialize(): Promise<void> {
    this.persistedState = await this.readPersistedState();
    await this.discover();
    const restored = this.persistedState.activeProjectId && this.projects.has(this.persistedState.activeProjectId)
      ? this.persistedState.activeProjectId
      : undefined;
    const configuredId = projectIdFor(this.options.cwd);
    this.setActiveProject(restored ?? (this.projects.has(configuredId) ? configuredId : this.newestProjectId()));
    await this.persistState();
  }

  private async discover(): Promise<void> {
    const discoveredWorkspaces = await this.discoverWorkspaceDirectories();
    const sessions = await this.discoverSessions();
    const workspaces = new Map<string, string>();
    for (const cwd of discoveredWorkspaces) workspaces.set(pathKey(cwd), cwd);
    for (const session of sessions) {
      if (!workspaces.has(pathKey(session.cwd))) workspaces.set(pathKey(session.cwd), resolve(session.cwd));
    }

    const sessionsByCwd = new Map<string, WorkBuddySession[]>();
    for (const session of sessions) {
      const list = sessionsByCwd.get(pathKey(session.cwd)) ?? [];
      list.push(session);
      sessionsByCwd.set(pathKey(session.cwd), list);
    }

    for (const cwd of workspaces.values()) {
      const id = projectIdFor(cwd);
      const projectSessions = (sessionsByCwd.get(pathKey(cwd)) ?? []).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const persistedSessionId = this.persistedState.projects[id]?.latestSessionId;
      const existing = this.projects.get(id);
      const persistedSession = projectSessions.find((session) => session.id === persistedSessionId);
      const selectedSession = persistedSession ?? projectSessions[0];
      const selectedSessionId = persistedSession?.id
        ?? (persistedSessionId && existing?.sessionId === persistedSessionId ? existing.sessionId : selectedSession?.id);
      const directoryStat = await stat(cwd).catch(() => undefined);
      const updatedAt = selectedSession?.updatedAt ?? directoryStat?.mtime.toISOString() ?? new Date().toISOString();
      if (existing) {
        existing.sessionId = selectedSessionId ?? existing.sessionId;
        existing.project.cwd = cwd;
        existing.project.sessionId = existing.sessionId;
        existing.project.sessionCount = projectSessions.length;
        if (existing.project.status === "idle" && selectedSession?.lastAssistantMessage) existing.project.lastMessage = selectedSession.lastAssistantMessage;
        if (Date.parse(updatedAt) > Date.parse(existing.project.updatedAt)) existing.project.updatedAt = updatedAt;
      } else {
        this.projects.set(id, {
          sessionId: selectedSessionId,
          project: {
            id,
            name: basename(cwd) || "WorkBuddy Workspace",
            description: `真实 WorkBuddy 工作区：${cwd}`,
            status: "idle",
            progress: selectedSession ? 100 : 0,
            updatedAt,
            lastMessage: selectedSession?.lastAssistantMessage ?? (selectedSession ? `历史会话：${selectedSession.title}` : "尚无历史会话"),
            cwd,
            sessionId: selectedSessionId,
            sessionCount: projectSessions.length,
            active: id === this.activeProjectId,
          },
        });
      }
      for (const session of projectSessions) session.projectId = id;
    }
    this.sessions = sessions.filter((session) => this.projects.has(session.projectId));
  }

  private async discoverWorkspaceDirectories(): Promise<Set<string>> {
    const found = new Set<string>();
    if (await this.isDirectory(this.options.cwd)) found.add(resolve(this.options.cwd));
    for (const root of this.projectRoots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isDirectory()) found.add(resolve(root, entry.name));
    }
    return found;
  }

  private async discoverSessions(): Promise<WorkBuddySession[]> {
    const projectDirectories = await readdir(this.sessionRoot, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const directory of projectDirectories) {
      if (!directory.isDirectory()) continue;
      const directoryPath = join(this.sessionRoot, directory.name);
      const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === ".jsonl") files.push(join(directoryPath, entry.name));
    }
    const parsed = await Promise.all(files.map((file) => this.parseSession(file)));
    return parsed.filter((session): session is WorkBuddySession => Boolean(session));
  }

  private async parseSession(file: string): Promise<WorkBuddySession | undefined> {
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat) return undefined;
    const raw = await readFile(file, "utf8").catch(() => "");
    let cwd: string | undefined;
    let sessionId = basename(file, extname(file));
    let title: string | undefined;
    let firstUserMessage: string | undefined;
    let lastAssistantMessage: string | undefined;
    let latestTimestamp: string | undefined;
    let messageCount = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line.replace(/^\uFEFF/, "")) as SessionLogEntry;
        cwd = entry.cwd ?? cwd;
        sessionId = entry.sessionId ?? entry.session_id ?? sessionId;
        if (entry.aiTitle?.trim()) title = entry.aiTitle.trim();
        if (entry.type === "message") {
          const text = textFromContent(entry.content);
          if (text) {
            messageCount += 1;
            if (entry.role === "user" && !firstUserMessage) firstUserMessage = text;
            if (entry.role === "assistant") lastAssistantMessage = text;
          }
        }
        const timestamp = asIso(entry.timestamp, fileStat.mtime);
        if (!latestTimestamp || Date.parse(timestamp) > Date.parse(latestTimestamp)) latestTimestamp = timestamp;
      } catch {
        // Ignore incomplete lines left by an interrupted CLI process.
      }
    }
    if (!cwd) return undefined;
    return {
      id: sessionId,
      projectId: projectIdFor(cwd),
      cwd: resolve(cwd),
      title: title ?? firstUserMessage?.slice(0, 60) ?? sessionId,
      updatedAt: latestTimestamp ?? fileStat.mtime.toISOString(),
      firstUserMessage,
      lastAssistantMessage,
      messageCount,
      file,
      active: false,
    };
  }

  private async runAgent(record: ProjectRecord, instruction: string): Promise<void> {
    if (this.desktopTransport === "desktop" && !await this.isWorkBuddyDesktopRunning()) {
      this.finishWithError(record, "WorkBuddy 桌面程序未运行");
      return;
    }
    await this.runCli(record, instruction);
  }

  private async finishCompleted(record: ProjectRecord, finalText: string): Promise<void> {
    this.runningProjectId = undefined;
    this.lastError = undefined;
    record.project.progress = 100;
    record.project.lastMessage = finalText || "真实 WorkBuddy 任务执行完成";
    this.touch(record.project);
    await this.persistState().catch((error) => this.recordPersistenceError(error));
    record.project.status = "completed";
    this.emit(record.project, "result", finalText || "真实 WorkBuddy 任务执行完成。");
  }

  private async runCli(record: ProjectRecord, instruction: string): Promise<void> {
    const args = [
      this.cliScript, "-p", "--output-format", "stream-json", "--include-partial-messages",
      "--permission-mode", this.options.permissionMode ?? "default",
      "--tools", this.options.tools ?? "default", "--max-turns", String(this.options.maxTurns ?? 8),
    ];
    if (record.sessionId) args.push("--resume", record.sessionId);
    args.push(instruction);

    const child = spawn(process.execPath, args, {
      cwd: record.project.cwd,
      env: { ...process.env, NO_COLOR: "1", CODEBUDDY_CONFIG_DIR: this.configDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let finalText = "";
    let revealedSessionId: string | undefined;
    const toolNames = new Set<string>();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as StreamMessage;
        if (message.session_id) {
          record.sessionId = message.session_id;
          record.project.sessionId = message.session_id;
          this.persistedState.projects[record.project.id] = { cwd: record.project.cwd!, latestSessionId: message.session_id };
          this.persistInBackground();
          if (!revealedSessionId && this.desktopTransport !== "cli" && this.desktopReveal) {
            revealedSessionId = message.session_id;
            void this.revealDesktopSession(record, message.session_id);
          }
        }
        if (message.type === "system" && message.subtype === "init") {
          record.project.progress = 20;
          record.project.lastMessage = `已连接 WorkBuddy 会话 ${record.sessionId ?? ""}`.trim();
          this.touch(record.project);
          this.emit(record.project, "progress", "真实 WorkBuddy Agent 会话已经建立。");
        }
        const block = message.event?.content_block;
        if (message.event?.type === "content_block_start" && block?.type === "tool_use" && block.name) {
          if (!toolNames.has(block.name)) {
            toolNames.add(block.name);
            record.project.progress = Math.min(85, record.project.progress + 10);
            record.project.lastMessage = `WorkBuddy 正在调用工具：${block.name}`;
            this.touch(record.project);
            this.emit(record.project, "progress", `WorkBuddy 正在调用工具 ${block.name}。`);
          }
          if (block.name === "AskUserQuestion") {
            this.emit(record.project, "progress", "WorkBuddy 正在准备向用户提问。");
          }
        }
        if (message.type === "assistant") {
          finalText = message.message?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("") || finalText;
          const questionBlock = message.message?.content?.find((item) => item.name === "AskUserQuestion");
          if (questionBlock?.input) this.setWaitingForInput(record, this.extractQuestion(questionBlock.input));
        }
        if (message.type === "result") {
          if (message.result) finalText = message.result;
          if (message.is_error) this.lastError = message.error ?? message.result ?? "WorkBuddy 执行失败";
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) this.lastError = error instanceof Error ? error.message : String(error);
      }
    });

    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      child.once("error", (error) => {
        this.finishWithError(record, error.message);
        finish();
      });
      child.once("close", async (code) => {
        if (settled) return;
        try {
          if (record.project.status === "waiting_input") {
            this.runningProjectId = undefined;
            await this.persistState().catch((error) => this.recordPersistenceError(error));
            return;
          }
          if (code !== 0 || this.lastError) {
            this.finishWithError(record, this.lastError ?? stderr.trim() ?? `CodeBuddy CLI 退出码 ${code}`);
            return;
          }
          const pendingQuestion = this.inferPendingQuestion(finalText);
          if (pendingQuestion) {
            this.setWaitingForInput(record, pendingQuestion);
            this.runningProjectId = undefined;
            await this.persistState().catch((error) => this.recordPersistenceError(error));
            return;
          }
          await this.finishCompleted(record, finalText);
        } finally {
          finish();
        }
      });
    });
  }

  private async revealDesktopSession(record: ProjectRecord, sessionId: string): Promise<void> {
    if (process.platform !== "win32" || !await this.isWorkBuddyDesktopRunning()) return;
    const deepLink = `workbuddy:///task/${encodeURIComponent(sessionId)}`;
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("explorer.exe", [deepLink], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolvePromise();
      });
    }).then(() => {
      this.emit(record.project, "progress", `已在 WorkBuddy 桌面端打开 Session ${sessionId}。`);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(record.project, "progress", `任务正在真实执行，但桌面 Session 自动打开失败：${message}`);
    });
  }

  private requireProject(projectId?: string): ProjectRecord {
    const selectedId = projectId ?? this.activeProjectId;
    if (!selectedId) throw new Error("尚未发现或打开 WorkBuddy 项目");
    const record = this.projects.get(selectedId);
    if (!record) throw new Error(`项目不存在：${selectedId}`);
    return record;
  }

  private setActiveProject(projectId?: string): void {
    if (!projectId) return;
    this.activeProjectId = projectId;
    this.persistedState.activeProjectId = projectId;
    for (const [id, record] of this.projects) record.project.active = id === projectId;
  }

  private newestProjectId(): string | undefined {
    return [...this.projects.values()].sort((a, b) => Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt))[0]?.project.id;
  }

  private async readPersistedState(): Promise<PersistedState> {
    for (const [index, file] of [this.stateFile, `${this.stateFile}.bak`].entries()) {
      try {
        const state = this.parsePersistedState(await readFile(file, "utf8"));
        if (state) {
          if (index === 1) this.persistenceError = "主状态文件无效，已从 .bak 恢复";
          return state;
        }
      } catch {
        // Try the backup, then start with an empty mapping.
      }
    }
    return { version: 1, projects: {} };
  }

  private async persistState(): Promise<void> {
    const projects: PersistedState["projects"] = {};
    for (const [id, record] of this.projects) {
      if (record.project.cwd) projects[id] = { cwd: record.project.cwd, latestSessionId: record.sessionId };
    }
    const snapshot: PersistedState = { version: 1, activeProjectId: this.activeProjectId, projects };
    this.persistedState = snapshot;
    this.persistQueue = this.persistQueue.catch(() => undefined).then(() => this.writePersistedState(snapshot));
    return this.persistQueue;
  }

  private async writePersistedState(snapshot: PersistedState): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    const backup = `${this.stateFile}.bak`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    try {
      const current = await readFile(this.stateFile, "utf8").catch(() => undefined);
      if (current && this.parsePersistedState(current)) await copyFile(this.stateFile, backup);
      await copyFile(temporary, this.stateFile);
      this.persistenceError = undefined;
    } catch (error) {
      this.recordPersistenceError(error);
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private parsePersistedState(raw: string): PersistedState | undefined {
    try {
      const value = JSON.parse(raw) as Partial<PersistedState>;
      return value.version === 1 && value.projects && typeof value.projects === "object"
        ? { version: 1, activeProjectId: value.activeProjectId, projects: value.projects }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private persistInBackground(): void {
    void this.persistState().catch((error) => this.recordPersistenceError(error));
  }

  private recordPersistenceError(error: unknown): void {
    this.persistenceError = error instanceof Error ? error.message : String(error);
  }

  private async isDirectory(path: string): Promise<boolean> {
    return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
  }

  private async isWorkBuddyDesktopRunning(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    if (this.desktopRunningCache && Date.now() - this.desktopRunningCache.checkedAt < 3_000) {
      return this.desktopRunningCache.value;
    }
    const value = await new Promise<boolean>((resolvePromise) => {
      const child = spawn("tasklist.exe", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/NH", "/FO", "CSV"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.once("error", () => resolvePromise(false));
      child.once("close", () => resolvePromise(/"WorkBuddy\.exe"/i.test(output)));
    });
    this.desktopRunningCache = { checkedAt: Date.now(), value };
    return value;
  }

  private async readVersion(): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [this.cliScript, "--version"], {
        windowsHide: true,
        env: { ...process.env, CODEBUDDY_CONFIG_DIR: this.configDir },
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolvePromise(output.trim()) : reject(new Error(`CLI 版本探测失败：${code}`)));
    });
  }

  private finishWithError(record: ProjectRecord, message: string): void {
    if (record.project.status === "failed" && this.lastError === message) return;
    this.runningProjectId = undefined;
    this.lastError = message;
    record.project.status = "failed";
    record.project.lastMessage = message;
    this.touch(record.project);
    this.persistInBackground();
    this.emit(record.project, "error", `真实 WorkBuddy 执行失败：${message}`);
  }

  private extractQuestion(input: unknown): string {
    if (!input || typeof input !== "object") return "WorkBuddy 请求用户确认。";
    const value = input as { question?: string; questions?: Array<{ question?: string }> };
    return value.question ?? value.questions?.[0]?.question ?? "WorkBuddy 请求用户确认。";
  }

  private inferPendingQuestion(text: string): string | undefined {
    const normalized = text.trim();
    if (!normalized || normalized.length > 2_000) return undefined;
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tail = lines.slice(-4).join("\n");
    if (/^如果.{0,30}(?:需要|想要|希望)/.test(tail)) return undefined;
    const asksForReply = /(?:请|麻烦)(?:直接)?(?:回复|选择|确认|输入|提供|告诉我)|(?:需要|等待)(?:你|您)?(?:的)?(?:回复|选择|确认|输入|回答)/.test(tail);
    const hasChoiceOrQuestion = /[？?]/.test(tail) || /(?:回复|选择|确认|输入).{0,12}(?:1|2|是|否|选项)/.test(tail);
    return asksForReply && hasChoiceOrQuestion ? normalized : undefined;
  }

  private setWaitingForInput(record: ProjectRecord, question: string): void {
    if (record.project.status === "waiting_input" && record.project.pendingQuestion === question) return;
    record.project.status = "waiting_input";
    record.project.progress = Math.max(record.project.progress, 65);
    record.project.pendingQuestion = question;
    record.project.lastMessage = question;
    this.touch(record.project);
    this.persistInBackground();
    this.emit(record.project, "question", `真实 WorkBuddy 需要你的回答：${question}`, question);
  }

  private emit(project: Project, type: WorkBuddyEventType, summary: string, question?: string): void {
    const event: WorkBuddyEvent = {
      id: randomUUID(), projectId: project.id, projectName: project.name, type, summary, question, createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    this.emitter.emit("event", clone(event));
  }

  private touch(project: Project): void {
    project.updatedAt = new Date().toISOString();
  }
}
