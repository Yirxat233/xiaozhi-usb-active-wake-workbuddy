# WorkBuddy 与小智主动播报

这块设备已确认是斑梨 / Guition JC3636W518 V2（360×360 圆屏、ST77916、PDM 麦克风），对应小智的 `taiji-pi-s3-pdm` 配置。

定制固件版本为 `2.2.3-taiji-pdm-wb4`。它基于 xiaozhi-esp32 v2.2.3，加入 PR #1939 的 MQTT `speak_request` / `speak_ready` 支持，并增加本机 USB 主动会话通道。显示、触摸和音频使用 V2 的配置，不能替换成 VIEWE SmartRing Plus 固件。

wb4 对语音命令和需要用户回答的问题，会把电脑生成的输入音频静默送入官方小智上行通道，再等待官方识别、对话和 TTS 完整结束。任务完成事件则使用 USB 本地直播放，只说项目名和“任务已完成”，设备直接从待机进入说话，不再经过“聆听中”；Web 弹窗仍显示完整回复。播放队列完全排空并静默 200ms 后才恢复唤醒词检测，避免播报尾音误唤醒。正常唤醒、云端语音播放和连续对话仍沿用官方流程。

## 已实现的两条通路

- **USB 主动会话**：语音命令或 WorkBuddy 提问 → Windows 生成静默输入 → USB → 设备开启官方 `xiaozhi.me` 会话 → 小智识别并回复。无需说“你好小智”。
- **本地完成播报（默认）**：WorkBuddy 完成事件 → Bridge 队列 → Windows 生成“项目名任务已完成”语音 → USB → 设备直接播放；不进入聆听状态，也不发送任务回复正文。
- **MQTT + UDP**：保留 PR #1939 的服务器主动唤醒协议。只有支持该协议的服务器发送请求时才会触发，不能假设 xiaozhi.me 官方服务会主动发送它。

主动会话仅在设备 idle 时开始，设备正在聆听或说话时事件排队。Bridge 收到官方 TTS 结束信号后才记录成功；USB 断开、云端通道关闭或回复超时时不会伪造成功。

## 启动与 MCP

在本项目目录运行：

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-usb-background.ps1
```

默认 COM5，调试台为 `http://127.0.0.1:8787/`，MCP 为 `http://127.0.0.1:8787/mcp`。不要同时启动两个使用 COM5 的 Bridge，串口监视器和烧录软件也不能同时占用它。

常驻脚本将进程号和日志写入 `data/runtime/`。Bridge 每 2 秒检查 WorkBuddy Session 的新问题和完成回复；监测游标写入 `data/workbuddy-state.json`，因此短暂重启后也能补发停机期间遗漏的结果。

待播报队列写入 `data/notification-queue.json`。如需 Windows 登录后自动恢复 Bridge，运行 `scripts/install-autostart.ps1`；卸载使用 `scripts/uninstall-autostart.ps1`。

本机 WorkBuddy 的 `.workbuddy/.mcp.json` 已添加 `xiaozhi-workbuddy-local` HTTP MCP，原来的 `connector-proxy` 保留；配置修改前另有备份。WorkBuddy 重新加载 MCP 或重启后可使用 `xiaozhi_speak` 工具。

测试播报：

```powershell
$body = @{text='任务已经完成，请查看电脑。'} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/speak -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

返回 `accepted: true` 表示官方小智已完成这次回复；409 表示本次未完成。这个直接测试接口不排队，WorkBuddy 产生的事件使用自动队列。自动队列原子保存到 `data/notification-queue.json`，Bridge 重启后会继续发送。

要让 USB 输入像用户讲话一样原样交给小智（例如触发小智云端 MCP），使用 `command` 模式：

```powershell
$body = @{text='让 WorkBuddy 的 text2 项目继续任务'; mode='command'} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/speak -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

`notify`（默认）会要求小智向用户播报通知；`command` 不添加通知提示词，直接合成并发送原始控制指令。Web 调试台也提供“通过 USB 发送指令”按钮。

对 WorkBuddy 做自动化验收时，优先使用精确项目接口。它会先在本地锁定真实项目，再让小智调用云端 MCP，避免项目名被语音识别缩短后误投：

```powershell
$body = @{project='text2'; message='只回复 USB_CLOUD_OK，不要修改文件'} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/usb/workbuddy -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

## 小智语音反向控制 WorkBuddy

本地 MCP 供电脑上的 WorkBuddy 使用。若要从小智麦克风发起 WorkBuddy 任务、回答任务提问，还需在 Web 调试台粘贴小智后台提供的云端 MCP 接入点。交付模式使用 Windows 当前用户 DPAPI 加密保存到 `data/xiaozhi-mcp.dpapi`，开机恢复 Bridge 后会自动重连；点击“断开”会删除凭据。开发模式也可临时设置 `XIAOZHI_MCP_ENDPOINT`。完整接入点含密钥，不要提交到代码库；本地 USB 播报本身不依赖它。

## 固件、备份与重建

可交付固件和源代码在 `firmware-flash-20260908/release/`。合并固件从地址 `0x0` 烧录，完整合并镜像会重置 NVS；本次实际使用分区烧录，保留了 NVS。

- 最初的副屏完整备份：`original-COM5-16MB.bin`。
- 刷定制版前的正常小智完整备份：`working-xiaozhi-before-custom.bin`。
- 编译配置：`fwb/src/sdkconfig.defaults.workbuddy`，ESP-IDF 5.5.2。
- 重新编译：`powershell -NoProfile -ExecutionPolicy Bypass -File .\fwb\build-firmware.ps1`。
- 合并镜像：同一脚本加 `-Action merge-bin`。

USB 控制只接收状态、播报、Opus 音频包、结束和取消命令，不提供执行电脑命令或修改设备文件的接口。
