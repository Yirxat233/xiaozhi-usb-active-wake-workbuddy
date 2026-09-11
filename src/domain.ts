export type ProjectStatus = "idle" | "running" | "waiting_input" | "completed" | "failed";

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  updatedAt: string;
  lastMessage?: string;
  pendingQuestion?: string;
  cwd?: string;
  sessionId?: string;
  sessionCount?: number;
  active?: boolean;
}

export interface WorkBuddySession {
  id: string;
  projectId: string;
  cwd: string;
  title: string;
  updatedAt: string;
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  lastAssistantMessageId?: string;
  pendingQuestion?: string;
  messageCount: number;
  file: string;
  active: boolean;
}

export type WorkBuddyEventType = "progress" | "question" | "result" | "error";

export interface WorkBuddyEvent {
  id: string;
  projectId: string;
  projectName: string;
  type: WorkBuddyEventType;
  summary: string;
  question?: string;
  createdAt: string;
}

export interface ListProjectsFilter {
  recentDays?: number;
  status?: ProjectStatus;
}

export interface WorkBuddyAdapter {
  listProjects(filter?: ListProjectsFilter): Promise<Project[]>;
  createProject(name: string, instruction?: string): Promise<Project>;
  openProject(query: string): Promise<Project>;
  getProject(projectId?: string): Promise<Project>;
  continueProject(projectId?: string, instruction?: string): Promise<Project>;
  replyToQuestion(projectId: string, answer: string): Promise<Project>;
  listPendingQuestions(): Promise<Project[]>;
  getRecentEvents(limit?: number): Promise<WorkBuddyEvent[]>;
  listSessions?(projectId?: string): Promise<WorkBuddySession[]>;
  subscribe(listener: (event: WorkBuddyEvent) => void): () => void;
  diagnostics?(): Promise<WorkBuddyDiagnostics>;
  close?(): void;
}

export interface WorkBuddyDiagnostics {
  adapter: string;
  connected: boolean;
  version?: string;
  cwd?: string;
  sessionId?: string;
  running?: boolean;
  projectCount?: number;
  sessionCount?: number;
  activeProjectId?: string;
  stateFile?: string;
  sessionRoot?: string;
  configDir?: string;
  desktopSessionIndexFile?: string;
  desktopDatabaseFile?: string;
  desktopWorkspaceRegistered?: boolean;
  externalSessionMonitor?: boolean;
  externalWatchIntervalMs?: number;
  transport?: string;
  desktopRunning?: boolean;
  desktopHelper?: string;
  persistenceError?: string;
  error?: string;
}

export type DeviceState = "idle" | "connecting" | "speaking" | "listening" | "offline";

export interface SpeakRequest {
  session_id: string;
  type: "speak_request";
  text: string;
  event_id: string;
  event_type: WorkBuddyEventType;
  intent?: "notify" | "command";
}

export interface SpeakRecord {
  request: SpeakRequest;
  ready: {
    session_id: string;
    type: "speak_ready";
    state: "ready";
  };
  sentAt: string;
}

export interface XiaozhiNotifier {
  getState(): DeviceState;
  getRecords(): SpeakRecord[];
  setState(state: DeviceState): void;
  speak(request: SpeakRequest): Promise<boolean>;
  subscribeState(listener: (state: DeviceState) => void): () => void;
  close?(): void;
}
