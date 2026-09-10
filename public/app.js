const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  snapshot: null,
  mcpProbe: null,
  logs: [],
  refreshTimer: null,
  refreshing: false,
  eventHistoryReady: false,
  seenEventIds: new Set(),
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const time = (iso) => new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(iso));

const request = async (url, options = {}) => {
  const started = performance.now();
  const method = options.method ?? "GET";
  try {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    addLog(method, url, Math.round(performance.now() - started), "ok");
    return body;
  } catch (error) {
    addLog(method, url, Math.round(performance.now() - started), "error", error.message);
    throw error;
  }
};

function addLog(method, url, duration, level, message = "") {
  state.logs.unshift({ at: new Date(), method, url, duration, level, message });
  state.logs = state.logs.slice(0, 80);
  renderLogs();
}

function renderLogs() {
  $("#logs").innerHTML = state.logs.length ? state.logs.map((log) => `
    <div class="log-line ${log.level}">
      <span>${time(log.at)}</span><span class="method">${escapeHtml(log.method)}</span>
      <span>${escapeHtml(log.url)} ${log.message ? `— ${escapeHtml(log.message)}` : ""}</span>
      <span>${log.duration}ms</span>
    </div>`).join("") : '<p class="empty-state">暂无客户端请求日志</p>';
}

function setStatus(name, kind, text) {
  const item = $(`[data-status="${name}"]`);
  item.classList.remove("ok", "warn", "error");
  item.classList.add(kind);
  $(`#${name}-status`).textContent = text;
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  const { bridge, workbuddy, xiaozhi } = snapshot;
  setStatus("bridge", bridge.ok ? "ok" : "error", bridge.ok ? "已连接" : "连接失败");
  setStatus(
    "workbuddy",
    workbuddy.ok ? "ok" : "error",
    `${workbuddy.adapter}${workbuddy.diagnostics?.version ? ` · v${workbuddy.diagnostics.version}` : ""}`,
  );
  const cloud = xiaozhi.mcp ?? { configured: false, connected: false, state: "disabled", reconnectAttempt: 0, toolCallCount: 0 };
  const cloudKind = cloud.connected ? "ok" : cloud.configured ? "warn" : "error";
  const cloudText = cloud.connected
    ? `已连接 · ${cloud.toolCallCount} calls`
    : cloud.configured ? `${cloud.state} · retry ${cloud.reconnectAttempt ?? 0}` : "未配置";
  setStatus("xiaozhi-mcp", cloudKind, cloudText);
  const deviceKind = xiaozhi.state === "offline" ? "error" : xiaozhi.state === "idle" ? "ok" : "warn";
  setStatus("device", deviceKind, xiaozhi.state);
  if (state.mcpProbe) {
    setStatus("mcp", state.mcpProbe.ok ? "ok" : "error", state.mcpProbe.ok ? `${state.mcpProbe.latencyMs}ms · ${state.mcpProbe.toolCount} tools` : "探测失败");
  }

  $("#last-update").textContent = `更新 ${time(snapshot.timestamp)} · 已运行 ${snapshot.uptimeSeconds}s`;
  $("#queue-count").textContent = xiaozhi.dispatcher.queued;
  $("#project-count").textContent = workbuddy.projects.length;
  $("#event-count").textContent = workbuddy.events.length;
  $("#notification-count").textContent = xiaozhi.notifications.length;

  $$("#device-buttons button").forEach((button) => button.classList.toggle("active", button.dataset.state === xiaozhi.state));
  $("#node-voice").classList.toggle("active", Boolean(cloud.connected || state.mcpProbe?.ok));
  $("#node-bridge").classList.toggle("active", bridge.ok);
  $("#node-workbuddy").classList.toggle("active", workbuddy.projects.some((project) => project.status === "running" || project.status === "waiting_input"));
  $("#node-device").classList.toggle("active", xiaozhi.state !== "idle" && xiaozhi.state !== "offline");

  renderDiagnosis(snapshot);
  renderProjects(workbuddy.projects);
  renderSessions(workbuddy.sessions ?? [], workbuddy.diagnostics ?? {});
  renderEvents(workbuddy.events);
  renderNotifications(xiaozhi.notifications);
  processNewEvents(workbuddy.events);
}

function renderDiagnosis(snapshot) {
  const { workbuddy, xiaozhi } = snapshot;
  const issues = [];
  if (!xiaozhi.mcp?.configured) issues.push({ type: "danger", mark: "!", title: "小智 MCP 云端未配置", detail: "设置 XIAOZHI_MCP_ENDPOINT 后重启 Bridge。" });
  else if (!xiaozhi.mcp.connected) issues.push({ type: "warning", mark: "↻", title: `小智 MCP 云端 ${xiaozhi.mcp.state}`, detail: xiaozhi.mcp.lastError ?? "正在建立 WebSocket 长连接。" });
  if (state.mcpProbe && !state.mcpProbe.ok) issues.push({ type: "danger", mark: "!", title: "MCP 连接失败", detail: state.mcpProbe.error });
  if (!workbuddy.ok) issues.push({ type: "danger", mark: "!", title: "WorkBuddy Adapter 不可用", detail: workbuddy.diagnostics?.error ?? "无法连接 WorkBuddy。" });
  if (workbuddy.diagnostics?.transport === "cli+desktop-reveal" && workbuddy.diagnostics?.desktopRunning === false) issues.push({ type: "warning", mark: "!", title: "WorkBuddy 桌面端未运行", detail: "任务仍会由官方 CLI 执行，但无法自动显示对应桌面 Session。" });
  if (workbuddy.ok && workbuddy.diagnostics?.transport === "cli+desktop-reveal" && workbuddy.diagnostics?.desktopRunning === true) issues.push({ type: "good", mark: "✓", title: "真实执行通道已就绪", detail: "官方 CLI 负责提交与执行，WorkBuddy 桌面端自动打开同一个 Session。" });
  if (workbuddy.diagnostics?.persistenceError) issues.push({ type: "warning", mark: "!", title: "Session 映射持久化异常", detail: workbuddy.diagnostics.persistenceError });
  if (xiaozhi.state === "offline") issues.push({ type: "danger", mark: "!", title: "小智设备离线", detail: "主动播报无法发送，请检查设备或 MQTT 连接。" });
  if (xiaozhi.dispatcher.queued > 0 && xiaozhi.state !== "idle") issues.push({ type: "warning", mark: "↻", title: `${xiaozhi.dispatcher.queued} 条播报被阻塞`, detail: `设备当前为 ${xiaozhi.state}，切换到 idle 后队列会自动发送。` });
  if (workbuddy.pendingQuestions.length > 0) issues.push({ type: "warning", mark: "?", title: "任务正在等待用户回答", detail: workbuddy.pendingQuestions.map((p) => `${p.name}：${p.pendingQuestion}`).join("；") });
  if (!state.mcpProbe) issues.push({ type: "neutral", mark: "i", title: "MCP 尚未探测", detail: "点击右上方“运行 MCP 探针”检查握手、工具发现与延迟。" });
  if (issues.length === 0) issues.push({ type: "good", mark: "✓", title: "当前链路正常", detail: "Bridge、本地 MCP、小智 MCP 云端和 WorkBuddy 均未发现异常。" });

  $("#issue-count").textContent = issues.filter((issue) => issue.type === "danger" || issue.type === "warning").length;
  $("#diagnosis-list").innerHTML = issues.map((issue) => `
    <div class="diagnosis ${issue.type}"><span>${issue.mark}</span><div><strong>${escapeHtml(issue.title)}</strong><p>${escapeHtml(issue.detail)}</p></div></div>
  `).join("");
}

function renderProjects(projects) {
  $("#projects").innerHTML = projects.length ? projects.map((project) => `
    <article class="project-card">
      <div class="project-top"><strong class="project-name">${escapeHtml(project.name)}${project.active ? ' <em class="active-label">ACTIVE</em>' : ""}</strong><span class="pill ${project.status}">${escapeHtml(project.status)}</span></div>
      <p class="project-description">${escapeHtml(project.description)}</p>
      <dl class="project-map"><div><dt>CWD</dt><dd title="${escapeHtml(project.cwd)}">${escapeHtml(project.cwd ?? "—")}</dd></div><div><dt>SESSION</dt><dd title="${escapeHtml(project.sessionId)}">${escapeHtml(project.sessionId ?? "新会话")}</dd></div></dl>
      <p class="project-message">${escapeHtml(project.lastMessage ?? "暂无消息")}</p>
      <div class="progress"><i style="width:${Math.max(0, Math.min(100, project.progress))}%"></i></div>
      <div class="project-footer"><span>${project.progress}% · ${project.sessionCount ?? 0} sessions</span><span>${time(project.updatedAt)}</span></div>
      <div class="project-actions">
        <button data-open-project="${escapeHtml(project.name)}">打开</button>
        <button data-test-project="${escapeHtml(project.name)}">执行连接测试</button>
      </div>
    </article>`).join("") : '<p class="empty-state">暂无项目数据</p>';
  $$('[data-open-project]').forEach((button) => button.addEventListener("click", () => sendVoice(`打开 ${button.dataset.openProject} 项目`)));
  $$('[data-test-project]').forEach((button) => button.addEventListener("click", async () => {
    await sendVoice(`打开 ${button.dataset.testProject} 项目`);
    await sendVoice("继续执行项目，只回复一句：Bridge 到 WorkBuddy 连接测试成功。不要修改文件。不要调用工具。");
  }));
}

function renderSessions(sessions, diagnostics) {
  $("#recovery-state").textContent = diagnostics.activeProjectId
    ? `${sessions.length} sessions · active ${diagnostics.activeProjectId}`
    : `${sessions.length} sessions · 未选择活动项目`;
  $("#adapter-paths").innerHTML = `
    <div><span>SESSION ROOT</span><code title="${escapeHtml(diagnostics.sessionRoot)}">${escapeHtml(diagnostics.sessionRoot ?? "—")}</code></div>
    <div><span>CONFIG DIR</span><code title="${escapeHtml(diagnostics.configDir)}">${escapeHtml(diagnostics.configDir ?? "—")}</code></div>
    <div><span>STATE FILE</span><code title="${escapeHtml(diagnostics.stateFile)}">${escapeHtml(diagnostics.stateFile ?? "—")}</code></div>
    <div><span>TRANSPORT</span><code>${escapeHtml(diagnostics.transport ?? "—")} · desktop ${diagnostics.desktopRunning === true ? "UP" : diagnostics.desktopRunning === false ? "DOWN" : "N/A"}</code></div>`;
  $("#sessions").innerHTML = sessions.length ? sessions.map((session) => `
    <article class="session-row ${session.active ? "active" : ""}">
      <div class="session-main"><strong>${escapeHtml(session.title)}</strong><p>${escapeHtml(session.lastAssistantMessage ?? session.firstUserMessage ?? "无消息摘要")}</p></div>
      <div class="session-meta"><code>${escapeHtml(session.id)}</code><span>${session.messageCount} messages · ${time(session.updatedAt)}</span></div>
      <span class="session-link">${session.active ? "RESTORE TARGET" : escapeHtml(session.projectId)}</span>
    </article>`).join("") : '<p class="empty-state">尚未在 WorkBuddy 配置目录中发现历史 Session</p>';
}

function renderEvents(events) {
  $("#events").innerHTML = events.length ? events.map((event) => `
    <div class="timeline-item ${event.type}">
      <span class="timeline-time">${time(event.createdAt)}</span><span class="timeline-marker"></span>
      <div class="timeline-body"><strong>${escapeHtml(event.type.toUpperCase())} · ${escapeHtml(event.projectName)}</strong><p>${escapeHtml(event.summary)}</p></div>
    </div>`).join("") : '<p class="empty-state">尚无事件，尝试继续一个项目</p>';
}

function renderNotifications(records) {
  $("#notifications").innerHTML = records.length ? [...records].reverse().map((record) => `
    <div class="protocol-entry">
      <div class="protocol-summary"><code>${escapeHtml(record.request.type)} · ${escapeHtml(record.request.event_type)}</code><span>${time(record.sentAt)}</span></div>
      <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
    </div>`).join("") : '<p class="empty-state">尚未产生主动播报</p>';
  $$(".protocol-summary").forEach((summary) => summary.addEventListener("click", () => summary.parentElement.classList.toggle("open")));
}

function processNewEvents(events) {
  if (!state.eventHistoryReady) {
    events.forEach((event) => state.seenEventIds.add(event.id));
    state.eventHistoryReady = true;
    return;
  }
  const significant = [...events]
    .reverse()
    .filter((event) => !state.seenEventIds.has(event.id) && ["result", "question", "error"].includes(event.type));
  events.forEach((event) => state.seenEventIds.add(event.id));
  for (const event of significant) showEventAlert(event);
}

function showEventAlert(event) {
  const labels = {
    result: { mark: "✓", kind: "TASK COMPLETED", title: `“${event.projectName}”已完成` },
    question: { mark: "?", kind: "INPUT REQUIRED", title: `“${event.projectName}”需要回答` },
    error: { mark: "!", kind: "TASK FAILED", title: `“${event.projectName}”执行失败` },
  };
  const label = labels[event.type] ?? labels.result;
  const alert = $("#event-alert");
  alert.className = `event-alert show ${event.type}`;
  $("#event-alert-mark").textContent = label.mark;
  $("#event-alert-kind").textContent = label.kind;
  $("#event-alert-title").textContent = label.title;
  $("#event-alert-message").textContent = event.summary;
  $("#event-alert-time").textContent = `${time(event.createdAt)} · ${event.id}`;
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(label.title, { body: event.summary, tag: event.id });
  }
}

function closeEventAlert() {
  $("#event-alert").className = "event-alert";
}

async function enableSystemNotifications() {
  if (!("Notification" in window)) {
    showToast("当前浏览器不支持系统通知", true);
    return;
  }
  const permission = await Notification.requestPermission();
  $("#notification-button").textContent = permission === "granted" ? "系统通知已启用" : "系统通知未授权";
  showToast(permission === "granted" ? "WorkBuddy 完成后会发送系统通知" : "未获得系统通知权限", permission !== "granted");
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    renderSnapshot(await request("/api/debug/snapshot"));
  } catch (error) {
    setStatus("bridge", "error", "无法连接");
    diagnoseBridgeFailure(error.message);
  } finally {
    state.refreshing = false;
  }
}

function diagnoseBridgeFailure(message) {
  $("#issue-count").textContent = "1";
  $("#diagnosis-list").innerHTML = `<div class="diagnosis danger"><span>!</span><div><strong>Bridge HTTP 不可达</strong><p>${escapeHtml(message)}。先确认 npm run dev 是否正在运行。</p></div></div>`;
}

async function runMcpProbe() {
  const button = $("#mcp-probe-button");
  button.disabled = true;
  button.textContent = "探测中…";
  try {
    state.mcpProbe = await request("/api/debug/mcp-probe", { method: "POST" });
    showToast(state.mcpProbe.ok ? `MCP 正常：${state.mcpProbe.toolCount} 个工具，${state.mcpProbe.latencyMs}ms` : `MCP 失败：${state.mcpProbe.error}`, !state.mcpProbe.ok);
    if (state.snapshot) renderSnapshot(state.snapshot);
  } catch (error) {
    state.mcpProbe = { ok: false, error: error.message };
    showToast(`MCP 探针失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "运行 MCP 探针";
  }
}

async function sendVoice(text) {
  $("#command-response").className = "command-response";
  $("#command-response").textContent = "正在发送…";
  try {
    const result = await request("/api/voice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
    });
    $("#command-response").textContent = result.reply;
    await refresh();
  } catch (error) {
    $("#command-response").textContent = `错误：${error.message}`;
    showToast(error.message, true);
  }
}

async function setDeviceState(deviceState) {
  try {
    await request("/api/mock/device-state", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: deviceState }),
    });
    showToast(`设备状态已切换为 ${deviceState}`);
    await refresh();
  } catch (error) { showToast(error.message, true); }
}

async function connectXiaozhiMcp(endpoint) {
  const input = $("#xiaozhi-mcp-endpoint");
  input.value = "";
  try {
    await request("/api/xiaozhi-mcp/connect", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }),
    });
    showToast("小智 MCP 正在连接，Token 未写入磁盘");
    await refresh();
  } catch (error) {
    showToast(`小智 MCP 连接失败：${error.message}`, true);
  }
}

async function disconnectXiaozhiMcp() {
  try {
    await request("/api/xiaozhi-mcp/disconnect", { method: "POST" });
    showToast("小智 MCP 已断开并从内存清除");
    await refresh();
  } catch (error) {
    showToast(`断开失败：${error.message}`, true);
  }
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = "toast", 3200);
}

$("#voice-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("#voice-input").value.trim();
  if (text) sendVoice(text);
});
$("#xiaozhi-mcp-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const endpoint = $("#xiaozhi-mcp-endpoint").value.trim();
  if (endpoint) connectXiaozhiMcp(endpoint);
});
$("#xiaozhi-mcp-disconnect").addEventListener("click", disconnectXiaozhiMcp);
$$('[data-command]').forEach((button) => button.addEventListener("click", () => {
  $("#voice-input").value = button.dataset.command;
  sendVoice(button.dataset.command);
}));
$$('[data-state]').forEach((button) => button.addEventListener("click", () => setDeviceState(button.dataset.state)));
$("#mcp-probe-button").addEventListener("click", runMcpProbe);
$("#refresh-button").addEventListener("click", refresh);
$("#notification-button").addEventListener("click", enableSystemNotifications);
$("#event-alert-close").addEventListener("click", closeEventAlert);
$("#event-alert").addEventListener("click", (event) => { if (event.target.id === "event-alert") closeEventAlert(); });
$("#clear-logs").addEventListener("click", () => { state.logs = []; renderLogs(); });
$("#auto-refresh").addEventListener("change", (event) => {
  clearInterval(state.refreshTimer);
  state.refreshTimer = event.target.checked ? setInterval(refresh, 1500) : null;
});

setInterval(() => $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }), 1000);
state.refreshTimer = setInterval(refresh, 1500);
refresh();
setTimeout(runMcpProbe, 400);
