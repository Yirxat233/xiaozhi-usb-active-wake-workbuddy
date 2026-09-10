import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ListProjectsFilter,
  Project,
  ProjectStatus,
  WorkBuddyAdapter,
  WorkBuddyEvent,
  WorkBuddyEventType,
} from "./domain.js";

const clone = <T>(value: T): T => structuredClone(value);

export class MockWorkBuddyAdapter implements WorkBuddyAdapter {
  private readonly emitter = new EventEmitter();
  private readonly projects = new Map<string, Project>();
  private readonly events: WorkBuddyEvent[] = [];
  private activeProjectId?: string;

  constructor(private readonly stepDelayMs = 250) {
    const now = Date.now();
    this.seed({
      id: "voice-bridge",
      name: "小智 WorkBuddy Bridge",
      description: "打通小智语音入口与 WorkBuddy 任务执行",
      status: "idle",
      progress: 15,
      updatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      lastMessage: "适配器设计已完成，等待继续执行",
    });
    this.seed({
      id: "active-wakeup",
      name: "小智主动唤醒固件",
      description: "基于 speak_request 协议的主动唤醒固件",
      status: "idle",
      progress: 35,
      updatedAt: new Date(now - 20 * 60 * 60 * 1000).toISOString(),
      lastMessage: "固件编译暂缓，等待 Bridge 链路验证",
    });
    this.seed({
      id: "older-demo",
      name: "旧版语音助手实验",
      description: "历史演示项目",
      status: "completed",
      progress: 100,
      updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
      lastMessage: "已完成",
    });
  }

  async listProjects(filter: ListProjectsFilter = {}): Promise<Project[]> {
    const cutoff = filter.recentDays
      ? Date.now() - filter.recentDays * 24 * 60 * 60 * 1000
      : 0;
    return [...this.projects.values()]
      .filter((project) => !filter.status || project.status === filter.status)
      .filter((project) => Date.parse(project.updatedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(clone);
  }

  async createProject(name: string, instruction?: string): Promise<Project> {
    const normalized = name.trim();
    if (!normalized) throw new Error("项目名称不能为空");
    const id = `created-${randomUUID()}`;
    const project: Project = {
      id,
      name: normalized,
      description: `新建 Mock 项目：${normalized}`,
      status: "idle",
      progress: 0,
      updatedAt: new Date().toISOString(),
      lastMessage: "项目已创建",
      active: true,
    };
    for (const current of this.projects.values()) current.active = false;
    this.projects.set(id, project);
    this.activeProjectId = id;
    return instruction?.trim() ? this.continueProject(id, instruction) : clone(project);
  }

  async openProject(query: string): Promise<Project> {
    const normalized = query.trim().toLocaleLowerCase();
    const candidates = [...this.projects.values()].filter((project) =>
      `${project.name} ${project.description} ${project.id}`.toLocaleLowerCase().includes(normalized),
    );
    if (candidates.length === 0) {
      throw new Error(`没有找到匹配“${query}”的项目`);
    }
    const project = candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]!;
    this.activeProjectId = project.id;
    project.updatedAt = new Date().toISOString();
    project.lastMessage = "项目已打开";
    return clone(project);
  }

  async getProject(projectId?: string): Promise<Project> {
    const id = projectId ?? this.activeProjectId;
    if (!id) throw new Error("当前没有已打开的项目");
    return clone(this.requireProject(id));
  }

  async continueProject(projectId?: string, instruction = "继续之前的项目进度"): Promise<Project> {
    const id = projectId ?? this.activeProjectId;
    if (!id) throw new Error("请先打开一个项目");
    const project = this.requireProject(id);
    if (project.status === "running") throw new Error(`项目“${project.name}”正在执行`);
    if (project.status === "waiting_input") throw new Error(`项目“${project.name}”正在等待回答`);

    this.activeProjectId = id;
    this.update(project, "running", Math.max(project.progress, 20), `开始执行：${instruction}`);
    this.emit(project, "progress", `项目“${project.name}”已经开始继续执行。`);
    this.runScenario(project.id);
    return clone(project);
  }

  async replyToQuestion(projectId: string, answer: string): Promise<Project> {
    const project = this.requireProject(projectId);
    if (project.status !== "waiting_input" || !project.pendingQuestion) {
      throw new Error(`项目“${project.name}”当前没有待回答问题`);
    }
    project.pendingQuestion = undefined;
    this.update(project, "running", 75, `收到回答：${answer}`);
    this.emit(project, "progress", `已收到回答，项目“${project.name}”继续执行。`);
    this.schedule(() => {
      const current = this.requireProject(projectId);
      this.update(current, "completed", 100, "Mock 链路验证完成");
      this.emit(current, "result", `项目“${current.name}”已经完成，Mock 全链路验证通过。`);
    });
    return clone(project);
  }

  async listPendingQuestions(): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((project) => project.status === "waiting_input")
      .map(clone);
  }

  async getRecentEvents(limit = 20): Promise<WorkBuddyEvent[]> {
    return this.events.slice(-limit).reverse().map(clone);
  }

  subscribe(listener: (event: WorkBuddyEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async diagnostics() {
    return { adapter: "MockWorkBuddyAdapter", connected: true, version: "mock" };
  }

  private seed(project: Project): void {
    this.projects.set(project.id, project);
  }

  private requireProject(id: string): Project {
    const project = this.projects.get(id);
    if (!project) throw new Error(`项目不存在：${id}`);
    return project;
  }

  private update(project: Project, status: ProjectStatus, progress: number, message: string): void {
    project.status = status;
    project.progress = progress;
    project.lastMessage = message;
    project.updatedAt = new Date().toISOString();
  }

  private emit(project: Project, type: WorkBuddyEventType, summary: string, question?: string): void {
    const event: WorkBuddyEvent = {
      id: randomUUID(),
      projectId: project.id,
      projectName: project.name,
      type,
      summary,
      question,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    this.emitter.emit("event", clone(event));
  }

  private runScenario(projectId: string): void {
    this.schedule(() => {
      const project = this.requireProject(projectId);
      if (project.status !== "running") return;
      this.update(project, "running", 45, "核心代码已生成，正在执行测试");
      this.emit(project, "progress", `项目“${project.name}”核心代码已生成，正在执行测试。`);
    });
    this.schedule(() => {
      const project = this.requireProject(projectId);
      if (project.status !== "running") return;
      const question = "测试需要模拟主动唤醒，是否允许继续？";
      this.update(project, "waiting_input", 65, question);
      project.pendingQuestion = question;
      this.emit(project, "question", `项目“${project.name}”需要你的确认：${question}`, question);
    }, 2);
  }

  private schedule(callback: () => void, multiplier = 1): void {
    setTimeout(callback, this.stepDelayMs * multiplier).unref();
  }
}
