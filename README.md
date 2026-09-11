# Xiaozhi USB Active Wake for WorkBuddy

通过 USB 让电脑主动向小智设备发起官方云端会话，无需说“你好小智”。当 WorkBuddy 的任务完成、需要用户回答或发生错误时，电脑将通知作为静默的上行语音送入设备；`xiaozhi.me` 完成识别和对话后，再由小智自己的角色与音色回复。

当前验证硬件为斑梨 / Guition JC3636W518 V2（ESP32-S3、360×360 圆屏、ST77916、PDM 麦克风），固件配置为 `taiji-pi-s3-pdm`。完整烧录和接线说明见 [LOCAL_USB_GUIDE.md](LOCAL_USB_GUIDE.md)。

## 已跑通的链路

```text
WorkBuddy task result / question / error
                    │
                    ▼
          Notification queue
                    │
                    ▼
 Windows speech → 16 kHz Opus → USB
                    │
                    ▼
 ESP32 opens an official xiaozhi.me conversation
                    │
                    ▼
        Xiaozhi cloud STT / LLM / TTS
                    │
                    ▼
        Device replies in Xiaozhi's voice
```

- 查询最近项目、模糊打开项目、继续任务、查询状态。
- WorkBuddy 主动产生进度、问题和完成事件。
- 每 2 秒监测 WorkBuddy 桌面 Session；即使任务直接从 WorkBuddy 发起，也会捕获新问题和最终回复。Bridge 短暂停止期间遗漏的完成结果会在重启后补偿入队。
- 设备忙碌时排队，恢复 `idle` 后自动发送。
- USB 输入结束后等待官方小智完整回复，再记录成功。
- 保留 PR #1939 的 MQTT `speak_request` / `speak_ready` 草案支持。
- 同时提供小智 MCP WebSocket、MCP Streamable HTTP、MCP stdio 和调试 HTTP API。

## 快速开始

```powershell
npm install
npm run check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-usb-background.ps1
```

后台脚本会让 Bridge 脱离当前终端持续运行，并把进程号和日志写入 `data/runtime/`。前台调试时仍可使用 `scripts/start-local-usb.ps1`。

交付机器建议再运行一次 `scripts/install-autostart.ps1` 安装当前用户登录自启；可用 `scripts/uninstall-autostart.ps1` 完整移除，用 `scripts/bridge-status.ps1` 查看状态。安装脚本不会保存小智 MCP Token。

需要 Windows 10/11、Node.js 20+、Python 3、FFmpeg，以及通过 USB 连接并已配网激活的小智设备。设置 `XIAOZHI_NOTIFIER=usb` 启用真实设备；未设置时使用模拟设备。

启动 HTTP 服务：

```powershell
npm run dev
```

默认地址：

- Web 调试控制台：`http://127.0.0.1:8787/`
- MCP：`http://127.0.0.1:8787/mcp`
- 健康检查：`http://127.0.0.1:8787/health`
- 模拟语音：`POST http://127.0.0.1:8787/api/voice`
- USB 原样输入：`POST http://127.0.0.1:8787/api/speak`，请求体使用 `{"text":"…","mode":"command"}`
- USB 精确 WorkBuddy 指令：`POST http://127.0.0.1:8787/api/usb/workbuddy`，请求体使用 `{"project":"准确项目名","message":"任务"}`
- 播报记录：`GET http://127.0.0.1:8787/api/notifications`

## Web 调试控制台

运行 `npm run dev` 后打开 `http://127.0.0.1:8787/`。控制台提供：

- Bridge、本地 MCP、小智 MCP 云端、WorkBuddy 和播报队列连接状态。
- MCP 真实握手与工具发现探针，显示延迟和工具数量。
- 语音命令模拟、USB 原样指令、快捷命令和设备状态切换。
- 项目状态、消息队列、事件时间线与 `speak_request` 原始协议记录。
- 根据离线、忙碌排队、待回答和 MCP 失败自动给出故障判断。

模拟语音请求：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8787/api/voice `
  -ContentType application/json `
  -Body '{"text":"查询一下近三天的项目清单"}'
```

## MCP Tools

| Tool | 用途 |
| --- | --- |
| `workbuddy_list_projects` | 查询项目列表 |
| `workbuddy_open_project` | 模糊匹配并打开项目 |
| `workbuddy_get_project_status` | 查询项目状态 |
| `workbuddy_continue_project` | 继续项目任务 |
| `workbuddy_send_message` | 按真实项目名或 ID 打开项目并实际发送消息 |
| `workbuddy_reply_to_question` | 回答任务问题 |
| `workbuddy_list_pending_questions` | 查询待回答问题 |
| `workbuddy_get_recent_events` | 查询事件历史 |
| `workbuddy_list_sessions` | 查询历史 Session 与恢复映射 |
| `xiaozhi_bridge_status` | 查询设备、队列和主动播报记录 |

## 连接小智 MCP 云端

在小智后台复制 `wss://api.xiaozhi.me/mcp/?token=...` 接入点。交付模式可直接在 Web 调试台中粘贴，Bridge 会用 Windows 当前用户 DPAPI 加密保存到 `data/xiaozhi-mcp.dpapi`，重启后自动恢复；页面与日志只显示去掉查询参数的地址。点击“断开”会删除该凭据。

开发环境也可以通过进程环境变量临时启动。完整地址包含密钥，不要提交到仓库或写入日志：

```powershell
$env:XIAOZHI_MCP_ENDPOINT = "wss://api.xiaozhi.me/mcp/?token=YOUR_TOKEN"
npm run dev
```

Bridge 会作为 MCP Server 主动连接小智云端，完成 `initialize`、工具发现和 `tools/call`，断线后按指数退避自动重连。调试台会展示连接状态、重试次数、收到的消息数、工具调用数、最近工具名和凭据存储方式（不记录参数与 Token）。

`/api/usb/workbuddy` 用于可重复的端到端验收：Bridge 先精确校验并短暂暂存项目 ID 与消息，再通过 USB 向小智发送触发语。若第一种措辞未触发工具，会等待设备恢复并自动尝试另外两种；小智云端调用发送/继续工具时取走暂存指令。这样即使语音识别只保留“发送消息”，也不会模糊匹配到错误项目；若三次都没有调用执行工具，接口会返回 `dispatched: false` 和实际 `attempts`。

## 本地 stdio 配置

MCP 宿主也可以直接启动 stdio 入口：

```json
{
  "mcpServers": {
    "xiaozhi-workbuddy": {
      "command": "npm",
      "args": ["run", "mcp:stdio", "--silent"],
      "cwd": "C:/path/to/xiaozhi-usb-active-wake-workbuddy"
    }
  }
}
```

## 使用本机真实 WorkBuddy

真实模式默认映射 WorkBuddy 桌面端的 `.workbuddy` Session。WorkBuddy 5.3.x 的创建/发送 RPC 只开放给 Electron 内部 IPC，外部程序无法安全调用；因此 `auto`/`desktop` 模式使用 WorkBuddy 自带 CLI 真正执行任务，并在拿到 Session ID 后通过官方深链自动打开同一个桌面 Session：

```powershell
$env:WORKBUDDY_ADAPTER = "codebuddy"
$env:WORKBUDDY_CWD = "C:\path\to\WorkBuddy\project"
$env:WORKBUDDY_PROJECT_ROOTS = "C:\path\to\WorkBuddy"
$env:WORKBUDDY_CONFIG_DIR = "$env:USERPROFILE\.workbuddy"
$env:WORKBUDDY_SESSION_ROOT = "$env:USERPROFILE\.workbuddy\projects"
$env:WORKBUDDY_STATE_FILE = ".\data\workbuddy-state.json"
$env:WORKBUDDY_TRANSPORT = "auto"
$env:CODEBUDDY_CLI_SCRIPT = "$env:LOCALAPPDATA\Programs\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js"
$env:WORKBUDDY_PERMISSION_MODE = "default"
npm run dev
```

控制台会显示 `CodeBuddyCliAdapter`、CLI 版本、多项目工作目录、历史 Session、当前恢复目标和状态文件位置。项目卡片中的“执行连接测试”会发起真实 WorkBuddy 模型请求，但明确禁止工具调用与文件修改。

当前映射关系：

- Bridge 扫描 `WORKBUDDY_PROJECT_ROOTS` 的一级目录，并合并 `WORKBUDDY_SESSION_ROOT` 中 JSONL 记录引用的工作区。
- 项目 ID 根据规范化绝对路径稳定生成；JSONL 会话会提取标题、首条输入、最近回复与更新时间。
- 当前活动项目和每个项目的最后 Session 串行写入 `WORKBUDDY_STATE_FILE`，并保留 `.bak`；重启时主文件损坏会自动回退到备份。
- 无历史 Session 时，`continue_project` 通过官方 CLI `stream-json` 创建真实 Agent Session；已有 Session 时使用 `--resume <sessionId>` 恢复上下文。
- `auto`/`desktop` 模式取得 Session ID 后，会原子更新 `.workbuddy/app/sessions.json`，并事务性同步 `workbuddy.db` 中对应的 `sessions` 与 `workspaces` 记录，使 Bridge 创建的真实项目出现在 WorkBuddy 左侧“空间”列表；不会改写任务 JSONL。每次 Bridge 进程首次同步前，都会把 SQLite 一致性备份保存到 `data/backups/`。
- Bridge 直接解析 CLI 的增量事件，将进度、提问、最终回复和错误映射为 `progress/question/result/error`；不会再出现“输入框有文字但任务没有发送”的假成功。
- 当当前 CLI 环境不提供 `AskUserQuestion` 工具时，Bridge 会识别 WorkBuddy 最终文字中的明确回复/选择请求并进入 `waiting_input`；Web 或小智的下一条回答通过同一 Session `--resume` 继续。
- `desktop` 模式要求 WorkBuddy 桌面程序已运行；`auto` 模式在桌面未运行时仍执行任务；`cli` 模式只执行，不自动打开桌面 Session。
- Web 调试台对 `result/question/error` 显示页内弹窗；用户点击“启用系统通知”后还会产生浏览器系统通知。

小智主动调用 WorkBuddy 的 MCP 路径与异步主动播报是两个方向的链路。现在可用 `UsbXiaozhiNotifier` 将 WorkBuddy 完成/提问事件送回本机 USB 连接的小智。设备忙碌时排队，播放完成后才记录成功；过长回复会压缩为项目名和短摘要，Web 弹窗保留全文，避免云端单轮聆听超时。待播报队列和最近事件 ID 原子保存到 `data/notification-queue.json`，Bridge 或 Windows 重启后会自动续播。
