import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodeBuddyCliAdapter } from "../src/codebuddy-cli-adapter.js";

const sleep = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const waitFor = async (predicate: () => Promise<boolean>, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("等待条件超时");
};

test("real adapter maps CodeBuddy stream-json into bridge events", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "workbuddy-adapter-"));
  const adapter = new CodeBuddyCliAdapter({
    cwd: process.cwd(),
    projectRoots: [join(temporary, "workspaces")],
    sessionRoot: join(temporary, "sessions"),
    stateFile: join(temporary, "state.json"),
    cliScript: resolve("tests/fixtures/fake-codebuddy.mjs"),
    tools: "",
    maxTurns: 1,
  });

  try {
    const diagnostics = await adapter.diagnostics();
    assert.equal(diagnostics.connected, true);
    assert.equal(diagnostics.version, "2.test.0");

    const started = await adapter.continueProject(undefined, "连接测试");
    assert.equal(started.status, "running");
    await waitFor(async () => (await adapter.getProject()).status === "completed");

    const completed = await adapter.getProject();
    assert.equal(completed.lastMessage, "FAKE:连接测试");
    const events = await adapter.getRecentEvents();
    assert.ok(events.some((event) => event.type === "progress"));
    assert.ok(events.some((event) => event.type === "result"));
    assert.equal((await adapter.diagnostics()).sessionId, "fake-session-1");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("discovers multiple WorkBuddy projects and restores the active historical session after restart", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "workbuddy-recovery-"));
  const root = join(temporary, "workspaces");
  const alpha = join(root, "Alpha");
  const beta = join(root, "Beta");
  const sessionRoot = join(temporary, "sessions");
  const stateFile = join(temporary, "bridge-state.json");
  const fakeCli = resolve("tests/fixtures/fake-codebuddy.mjs");
  await Promise.all([mkdir(alpha, { recursive: true }), mkdir(beta, { recursive: true })]);

  const writeSession = async (folder: string, sessionId: string, cwd: string, title: string, timestamp: string) => {
    const target = join(sessionRoot, folder);
    await mkdir(target, { recursive: true });
    const entries = [
      { type: "message", role: "user", content: [{ type: "input_text", text: `开始 ${title}` }], sessionId, cwd, timestamp },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: `${title} 最近回复` }], sessionId, cwd, timestamp },
      { type: "ai-title", aiTitle: title, sessionId, cwd, timestamp },
    ];
    await writeFile(join(target, `${sessionId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  };

  try {
    await writeSession("encoded-alpha", "session-alpha", alpha, "Alpha 会话", "2026-08-30T10:00:00.000Z");
    await writeSession("encoded-beta", "session-beta", beta, "Beta 会话", "2026-08-31T10:00:00.000Z");
    const options = { cwd: alpha, projectRoots: [root], sessionRoot, stateFile, cliScript: fakeCli, tools: "", maxTurns: 1 };
    const first = new CodeBuddyCliAdapter(options);
    const projects = await first.listProjects();
    assert.deepEqual(projects.map((project) => project.name).sort(), ["Alpha", "Beta"]);
    assert.equal((await first.listSessions()).length, 2);
    const opened = await first.openProject("Beta");
    assert.equal(opened.sessionId, "session-beta");
    assert.equal(opened.active, true);

    for (let index = 0; index < 12; index += 1) {
      await first.openProject(index % 2 === 0 ? "Alpha" : "Beta");
    }
    const reopened = await first.openProject("Beta");
    assert.equal(reopened.sessionId, "session-beta");

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { activeProjectId: string };
    assert.equal(persisted.activeProjectId, reopened.id);
    assert.equal(JSON.parse(await readFile(`${stateFile}.bak`, "utf8")).version, 1);
    assert.equal((await readdir(temporary)).some((file) => file.endsWith(".tmp")), false);

    const restarted = new CodeBuddyCliAdapter(options);
    const diagnostics = await restarted.diagnostics();
    assert.equal(diagnostics.activeProjectId, reopened.id);
    assert.equal(diagnostics.sessionId, "session-beta");
    await restarted.continueProject("Beta", "重启恢复测试");
    await waitFor(async () => (await restarted.getProject()).status === "completed");
    assert.equal((await restarted.getProject()).lastMessage, "FAKE-RESUMED:session-beta:重启恢复测试");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("auto transport executes with the official CLI session and persists its mapping", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "workbuddy-native-session-"));
  const root = join(temporary, "workspaces");
  const workspace = join(root, "NativeProject");
  const sessionRoot = join(temporary, "sessions");
  const stateFile = join(temporary, "bridge-state.json");
  const fakeCli = resolve("tests/fixtures/fake-codebuddy.mjs");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);

  try {
    await mkdir(join(temporary, "app"), { recursive: true });
    const desktopDatabaseFile = join(temporary, "workbuddy.db");
    const desktopDatabase = new DatabaseSync(desktopDatabaseFile);
    desktopDatabase.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        user_id TEXT,
        title TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        deleted_at INTEGER,
        is_playground INTEGER NOT NULL DEFAULT 0,
        source_mode TEXT,
        mode TEXT,
        model TEXT,
        permission_mode TEXT,
        use_sandbox_cli INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE workspaces (
        path TEXT PRIMARY KEY,
        last_opened_at INTEGER NOT NULL
      );
      INSERT INTO sessions (
        id, cwd, user_id, title, status, created_at, updated_at, is_playground
      ) VALUES (
        'existing-session', '${join(root, "Existing").replaceAll("'", "''")}',
        'real-user-id', 'Existing', 'completed', 1, 1, 0
      );
    `);
    desktopDatabase.close();
    await writeFile(join(temporary, "app", "sessions.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-08-30T00:00:00.000Z",
      sessions: [{
        conversationId: "existing-session",
        userId: "real-user-id",
        workDir: join(root, "Existing"),
        startedAt: "2026-08-30T00:00:00.000Z",
        resumedAt: "2026-08-30T00:00:00.000Z",
      }],
    }), "utf8");
    const adapter = new CodeBuddyCliAdapter({
      cwd: workspace,
      projectRoots: [root],
      sessionRoot,
      stateFile,
      cliScript: fakeCli,
      desktopTransport: "auto",
      desktopReveal: false,
    });
    await adapter.continueProject(undefined, "从 Web 创建真实任务");
    await waitFor(async () => (await adapter.getProject()).status === "completed", 3_000);

    const completed = await adapter.getProject();
    assert.equal(completed.sessionId, "fake-session-1");
    assert.equal(completed.lastMessage, "FAKE:从 Web 创建真实任务");
    const desktopIndex = JSON.parse(await readFile(join(temporary, "app", "sessions.json"), "utf8")) as {
      sessions: Array<{ conversationId: string; userId: string; workDir: string; title?: string }>;
    };
    assert.equal(desktopIndex.sessions[0]?.conversationId, "fake-session-1");
    assert.equal(desktopIndex.sessions[0]?.userId, "real-user-id");
    assert.equal(desktopIndex.sessions[0]?.workDir, workspace);
    assert.equal(desktopIndex.sessions[0]?.title, "NativeProject");
    assert.ok(desktopIndex.sessions.some((session) => session.conversationId === "existing-session"));
    const verifiedDatabase = new DatabaseSync(desktopDatabaseFile, { readOnly: true });
    const registeredSession = verifiedDatabase.prepare(
      "SELECT id, cwd, user_id, status, is_playground FROM sessions WHERE id = ?",
    ).get("fake-session-1") as { id: string; cwd: string; user_id: string; status: string; is_playground: number } | undefined;
    const registeredWorkspace = verifiedDatabase.prepare(
      "SELECT path FROM workspaces WHERE path = ?",
    ).get(workspace) as { path: string } | undefined;
    verifiedDatabase.close();
    assert.deepEqual(registeredSession ? { ...registeredSession } : undefined, {
      id: "fake-session-1",
      cwd: workspace,
      user_id: "real-user-id",
      status: "completed",
      is_playground: 0,
    });
    assert.equal(registeredWorkspace?.path, workspace);
    assert.ok((await readdir(join(temporary, "backups"))).some((file) => /^workbuddy-.*\.db$/.test(file)));
    assert.equal((await adapter.diagnostics()).desktopWorkspaceRegistered, true);
    await waitFor(async () => {
      try {
        const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { projects: Record<string, { latestSessionId?: string }> };
        return persisted.projects[completed.id]?.latestSessionId === "fake-session-1";
      } catch {
        return false;
      }
    });
    assert.ok((await adapter.getRecentEvents()).some((event) => event.type === "result" && event.summary === "FAKE:从 Web 创建真实任务"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("textual WorkBuddy question waits for input and resumes the same session", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "workbuddy-question-"));
  const root = join(temporary, "workspaces");
  const workspace = join(root, "QuestionProject");
  await mkdir(workspace, { recursive: true });
  const adapter = new CodeBuddyCliAdapter({
    cwd: workspace,
    projectRoots: [root],
    sessionRoot: join(temporary, "sessions"),
    stateFile: join(temporary, "state.json"),
    cliScript: resolve("tests/fixtures/fake-codebuddy.mjs"),
    desktopTransport: "cli",
  });

  try {
    await adapter.continueProject(undefined, "ASK_FOR_INPUT");
    await waitFor(async () => (await adapter.getProject()).status === "waiting_input");
    const waiting = await adapter.getProject();
    assert.equal(waiting.sessionId, "fake-session-1");
    assert.match(waiting.pendingQuestion ?? "", /回复 1 或 2/);
    assert.ok((await adapter.getRecentEvents()).some((event) => event.type === "question"));

    await adapter.replyToQuestion(waiting.id, "1");
    await waitFor(async () => (await adapter.getProject()).status === "completed");
    const completed = await adapter.getProject();
    assert.equal(completed.sessionId, "fake-session-1");
    assert.equal(completed.lastMessage, "FAKE-RESUMED:fake-session-1:用户对上一个问题的回答是：1");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("watches WorkBuddy desktop session changes and recovers completions missed while stopped", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "workbuddy-external-watch-"));
  const root = join(temporary, "workspaces");
  const workspace = join(root, "DesktopProject");
  const sessionRoot = join(temporary, "sessions");
  const sessionDirectory = join(sessionRoot, "desktop-project");
  const sessionFile = join(sessionDirectory, "desktop-session.jsonl");
  const stateFile = join(temporary, "state.json");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sessionDirectory, { recursive: true })]);
  const line = (entry: object) => `${JSON.stringify({ ...entry, sessionId: "desktop-session", cwd: workspace })}\n`;
  await writeFile(sessionFile, [
    line({ id: "user-1", timestamp: 1, type: "message", role: "user", content: [{ type: "input_text", text: "开始" }] }),
    line({ id: "assistant-1", timestamp: 2, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "旧回复" }] }),
  ].join(""), "utf8");

  const options = {
    cwd: workspace,
    projectRoots: [root],
    sessionRoot,
    stateFile,
    cliScript: resolve("tests/fixtures/fake-codebuddy.mjs"),
    desktopTransport: "cli" as const,
    externalWatchIntervalMs: 25,
  };
  const adapter = new CodeBuddyCliAdapter(options);
  const events: Array<{ type: string; summary: string }> = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event));
  let restarted: CodeBuddyCliAdapter | undefined;
  try {
    await adapter.listSessions();
    await appendFile(sessionFile, [
      line({ id: "user-2", timestamp: 3, type: "message", role: "user", content: [{ type: "input_text", text: "桌面输入" }] }),
      line({ id: "assistant-2", timestamp: 4, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "桌面任务完成" }] }),
    ].join(""), "utf8");
    await waitFor(async () => events.some((event) => event.type === "result" && event.summary === "桌面任务完成"), 2_000);
    assert.equal(events.filter((event) => event.type === "result" && event.summary === "桌面任务完成").length, 1);
    await appendFile(sessionFile, [
      line({ id: "user-question", timestamp: 5, type: "message", role: "user", content: [{ type: "input_text", text: "帮我查天气" }] }),
      line({ id: "assistant-question", timestamp: 6, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "请告诉我城市名，我再继续查询？" }] }),
    ].join(""), "utf8");
    await waitFor(async () => events.some((event) => event.type === "question" && event.summary.includes("城市名")), 2_000);
    await waitFor(async () => {
      const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { observedSessions?: Record<string, { assistantMessageId?: string }> };
      return persisted.observedSessions?.["desktop-session"]?.assistantMessageId === "assistant-question";
    }, 2_000);
    adapter.close();
    unsubscribe();

    await appendFile(sessionFile, [
      line({ id: "user-3", timestamp: 7, type: "message", role: "user", content: [{ type: "input_text", text: "Bridge 停止期间输入" }] }),
      line({ id: "assistant-3", timestamp: 8, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "重启补偿完成" }] }),
    ].join(""), "utf8");
    restarted = new CodeBuddyCliAdapter(options);
    const recoveredEvents: Array<{ type: string; summary: string }> = [];
    restarted.subscribe((event) => recoveredEvents.push(event));
    await restarted.listSessions();
    await waitFor(async () => recoveredEvents.some((event) => event.type === "result" && event.summary === "重启补偿完成"), 2_000);
  } finally {
    adapter.close();
    restarted?.close();
    unsubscribe();
    await rm(temporary, { recursive: true, force: true });
  }
});
