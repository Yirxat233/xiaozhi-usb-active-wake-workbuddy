import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    await restarted.continueProject(undefined, "重启恢复测试");
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
