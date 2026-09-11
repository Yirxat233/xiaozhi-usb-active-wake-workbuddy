小智 × WorkBuddy USB 固件（客户 smart-ring-pluss 工程）
版本：wb5

一、先按硬件选目录，不能混刷

1. 01-viewe-smartring-plus-new-hardware
   新版圆形硬件：带喇叭、带电池。
   工程目标：viewe-smartring-plus
   屏幕配置：SMARTRING_PLUS_USE_NEW_LCD=1

2. 02-taiji-pi-s3-pdm-old-hardware
   老版圆形硬件：磁吸供电。
   工程目标：taiji-pi-s3
   麦克风配置：I2S_TYPE_PDM

二、推荐烧录方式

使用乐鑫 Flash Download Tool，芯片选择 ESP32-S3：
- 选择对应目录中的 merged-flash-16MB.bin
- 烧录地址填写 0x0
- Flash 大小选择 16MB
- SPI 模式 DIO，频率 80MHz
- 烧录前确认选择的目录与实物硬件一致

如果使用 ESP-IDF/esptool，可在对应目录执行 flash_args 中的分区参数。

三、功能说明

- WorkBuddy 任务完成时，通过 USB 在设备本地播放简短提示，只播报“某某项目已完成”。
- 本地完成提示不会开启云端会话，因此设备播报后回到待机，不应停在“聆听中”。
- 用户语音提问仍可走小智云端会话。
- USB 控制协议及开发编译说明见源码中的 WORKBUDDY_USB.md。

四、完整性校验

SHA256SUMS.txt 包含交付包内所有文件的 SHA-256。烧录前可用 Windows PowerShell：
Get-FileHash .\merged-flash-16MB.bin -Algorithm SHA256

核对哈希不一致时不要烧录，请重新获取文件。
