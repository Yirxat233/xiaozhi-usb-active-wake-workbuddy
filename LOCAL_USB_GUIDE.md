# WorkBuddy 与小智主动播报

这块设备已确认是斑梨 / Guition JC3636W518 V2（360×360 圆屏、ST77916、PDM 麦克风），对应小智的 `taiji-pi-s3-pdm` 配置。

定制固件版本为 `2.2.3-taiji-pdm-wb3`。它基于 xiaozhi-esp32 v2.2.3，加入 PR #1939 的 MQTT `speak_request` / `speak_ready` 支持，并增加本机 USB 主动会话通道。显示、触摸和音频使用 V2 的配置，不能替换成 VIEWE SmartRing Plus 固件。

wb3 会把电脑生成的输入音频静默送入官方小智的上行通道，屏蔽同一时刻的麦克风音频，输入结束后等待官方识别、对话和 TTS 完整结束。正常唤醒、云端语音播放和连续对话仍沿用官方流程。

## 已实现的两条通路

- **USB 主动会话（默认）**：WorkBuddy 事件 → Bridge 队列 → Windows 生成静默输入 → USB → 设备开启官方 `xiaozhi.me` 会话 → 小智识别消息并用自己的角色和音色回复。无需说“你好小智”；需要设备用数据线连接本机，且 Bridge 保持运行。
- **本地直播放（固件备用能力）**：电脑也可以直接推送 24 kHz Opus 给扬声器，不经过官方服务；默认的 WorkBuddy 通知不再使用它。
- **MQTT + UDP**：保留 PR #1939 的服务器主动唤醒协议。只有支持该协议的服务器发送请求时才会触发，不能假设 xiaozhi.me 官方服务会主动发送它。

主动会话仅在设备 idle 时开始，设备正在聆听或说话时事件排队。Bridge 收到官方 TTS 结束信号后才记录成功；USB 断开、云端通道关闭或回复超时时不会伪造成功。

## 启动与 MCP

在本项目目录运行：

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-usb.ps1
```

默认 COM5，调试台为 `http://127.0.0.1:8787/`，MCP 为 `http://127.0.0.1:8787/mcp`。不要同时启动两个使用 COM5 的 Bridge，串口监视器和烧录软件也不能同时占用它。

本机 WorkBuddy 的 `.workbuddy/.mcp.json` 已添加 `xiaozhi-workbuddy-local` HTTP MCP，原来的 `connector-proxy` 保留；配置修改前另有备份。WorkBuddy 重新加载 MCP 或重启后可使用 `xiaozhi_speak` 工具。

测试播报：

```powershell
$body = @{text='任务已经完成，请查看电脑。'} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/speak -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

返回 `accepted: true` 表示官方小智已完成这次回复；409 表示本次未完成。这个直接测试接口不排队，WorkBuddy 产生的事件使用自动队列。当前队列保存在内存中，关闭 Bridge 会清除未发送队列。

## 小智语音反向控制 WorkBuddy

本地 MCP 供电脑上的 WorkBuddy 使用。若要从小智麦克风发起 WorkBuddy 任务、回答任务提问，还需在小智后台添加 Bridge 的云端 MCP 接入点，启动时设置 `XIAOZHI_MCP_ENDPOINT`。完整接入点含密钥，不要提交到代码库。此配置沿用项目原有功能；当前本地 USB 播报不依赖它。

## 固件、备份与重建

可交付固件和源代码在 GitHub Release 中。合并固件从地址 `0x0` 烧录，完整合并镜像会重置 NVS；如需保留 NVS，请只将构建出的 `xiaozhi.bin` 写入 `0x20000`。

- 编译配置：`firmware/xiaozhi-esp32/sdkconfig.defaults.workbuddy`，ESP-IDF 5.5.2。
- 在 ESP-IDF 5.5.2 终端重新编译：`powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\build-firmware.ps1`。
- 合并镜像：同一脚本加 `-Action merge-bin`。

USB 控制只接收状态、播报、Opus 音频包、结束和取消命令，不提供执行电脑命令或修改设备文件的接口。
