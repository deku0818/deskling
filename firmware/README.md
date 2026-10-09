# Deskling ESP32 显示端

目标板：**Waveshare ESP32-S3-Touch-AMOLED-2.16**。不要使用 LCD-2.1 或 C6 的配置。

- ESP32-S3R8，16MB Flash，8MB Octal PSRAM
- 480×480 AMOLED，CO5300 / QSPI
- CST9220 / I2C 触摸，AXP2101 电源管理
- 使用微雪官方 BSP 2.0.1，ESP-IDF 5.5.5 和 LVGL 9.6.0

硬件资料：[官方文档](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16)、[官方源码](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.16)。

## 编译

先安装并激活 ESP-IDF 5.5.5（`source <ESP-IDF>/export.sh`）。在本目录执行：

```sh
python -m pip install Pillow
idf.py set-target esp32s3
idf.py build
```

组件管理器会下载官方板级支持、LVGL、WebSocket 和 mDNS 组件。宠物由 `tools/embed_pets.py` 从 `assets/pets` 编译：每帧转为调色板索引，动画首帧完整保存，后续帧只保存与上一帧不同的矩形，并通过回放所有动画逐帧校验。运行时只解码并重绘变化的区域（格式见 [docs/PET_DESIGN.md](../docs/PET_DESIGN.md)）。

显示初始化在 `main.c` 中自行完成，没有调用 `bsp_display_start()`。官方板级支持把 LVGL 绘制缓冲放在 PSRAM，而 SPI DMA 读不了 PSRAM，所以每刷一条屏幕都要临时在内部 RAM 申请约 46KB 中转；内部 RAM 碎片化时这一步会失败（日志中的 `ESP_ERR_NO_MEM`），对应区域就停在旧画面上。现在两块 20 行的绘制缓冲直接放在内部 RAM，共 37.5KB。为了腾出这部分空间，TLS 和 Wi-Fi/lwIP 的缓冲、串口 / DNS / 配网服务的任务栈、快照缓冲都放在 PSRAM。网络任务要写 NVS，它的栈必须留在内部 RAM。`perf` 命令会报告内部 RAM 的空闲量、最大连续块和开机以来的最低值。

## 备份与烧录

首次烧录前备份设备的完整 16MB Flash，保留出厂固件和原有配置。备份含设备配置，仅保存在本地，`backups/` 已加入 Git 忽略。

```sh
mkdir -p backups
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem1101 --baud 460800 read_flash 0 0x1000000 backups/original-flash.bin
```

```sh
idf.py -p /dev/cu.usbmodem1101 flash monitor
```

Ctrl+] 退出串口监视器。固件不主动擦除 NVS；如果已有 NVS 版本不兼容，会报告错误，先核对备份再决定如何迁移。

## 首次连接

推荐通过 USB 配置：

1. 在 Hub 电脑打开 `http://127.0.0.1:8787/setup.html`，连接 USB 数据线，点击“连接 Deskling”。请先关闭串口监视器。
2. 从设备扫描的 **2.4GHz Wi-Fi** 中选择网络，输入密码。修改已保存网络时密码留空可保留。
3. 点击“验证并保存”。Hub 自动提供本机 LAN 地址和独立设备凭证；设备验证 Wi-Fi 和 `/snapshot` 成功后一次性保存配置。无需手输地址或 Token，也不需要重启。
4. 失败时保留输入并尝试恢复原连接，返回修改后直接重试。

手机配网：在设备时钟 → 配置 → 网络设置 → Wi-Fi 中点“用手机配置”，扫描屏幕 Wi-Fi 二维码。连接后配网页面通常自动打开，未弹出时访问 `http://192.168.4.1`。在 Hub 添加设备页面开启“用手机配置”，在手机选网络、输入密码，最后在电脑 Hub 核对配对码并确认。

热点在连接过程中保持开启，便于查看进度和重试；成功后一分钟关闭，闲置或失败时十分钟关闭。Hub 行可直接进入重新配对流程，Wi-Fi 行保留已有 Hub 凭证。USB 和手机页面均提供“本机 Hub / 远程 Hub”选择。远程模式填写 HTTP(S) 基地址，支持已有显示 Token 或在服务器本机管理页 / SSH 隧道中开启配对、核对配对码。远程目标不参与 mDNS 回退；公网建议使用有效证书的 HTTPS。

配置保存在设备 `deskling/config_v3` NVS 单一 blob（保存 Hub 类型，兼容读取 v2 blob） 中；旧键在首次升级时兼容读取，不主动擦除。密码和凭证不编入固件、不写串口日志。Hub 的设备文件保存凭证摘要，配对窗口和未激活凭证有效期为五分钟，凭证只允许读取显示快照。USB 管理接口只接受本机同源请求。

Codex / Claude Code 仍在时钟 → 配置中切换并保存，切换来源时清空旧数据并重新订阅。

## 交互与显示

- 适配圆角屏：去除贴边内框，时钟和会话入口向内收至左右 36px、顶部 32px；底部额度收窄，详情页和配网页统一避开四角。宠物保持原有大小与位置。
- 左上角：上海时区时钟，联网后通过 SNTP 对时。
- 右上角或小人区域：打开会话列表，按 Hub 顺序显示标题及状态。
- 底部：Claude 显示 5H、WEEK、FABLE；Codex 显示 5H、WEEK。点击查看重置倒计时。
- 配额缺失显示 `--`；0% 保持为 0；重置到期显示等待刷新。
- Codex 按接口实际返回的窗口映射额度，不假设每个账号都有 5H。OpenAI 当前说明 Pro 没有 5 小时用量限制，因此这类账号可能只返回周额度。
- 两个来源共用同一只宠物（默认 Clawd），按整体状态轮换走动、放大镜、挥手、跳跃和跳舞等动画；离线和出错时显示静止画面。
- 同一来源断线时保留上次配额与会话，显示 OFFLINE；切换来源时清空。
- 右上角用简洁状态段表示会话。来源切换仅放在设置页。

## 当前范围

已加入 USB 配置、Wi-Fi 扫描、二维码、captive portal DNS 和验证后保存；不同手机系统的自动弹窗行为可能不同，可用固定地址进入。触屏恢复出厂尚未加入。界面使用与网页相同的 Fusion Pixel Font，24px 字库包含常用简繁汉字、部分扩展 A 区字形、假名、拉丁字符及常用标点；额外用 Noto 补齐像素字体缺失的 1,770 个基础汉字。补充平面生僻字和 emoji 尚未覆盖。长标题按 UTF-8 字符边界截断。字库来源、授权和重建方式见 `main/fonts/README.md`。WebSocket 固定 5 秒重连，尚未按错误分类和指数退避；配置失败时保留旧 NVS 配置并尝试恢复原连接。

硬件运行验证以实际串口日志和屏幕/触摸观察为准；编译成功不代表已完成实机验证。

## 测试与原生 UI 预览

激活 ESP-IDF 后，在 `firmware/` 执行：

```sh
python tools/test_protocol.py
python tools/test_provision_config.py
```

协议测试覆盖异常快照、中文标题、缺失额度与 0%、会话上限、来源隔离及 v1 兼容。配置测试覆盖本机 / 远程目标隔离、Wi-Fi / Hub 独立保留、URL 校验及旧配置迁移。

[`tools/preview/`](tools/preview/README.md) 使用生产 UI、宠物和字体代码渲染 480×480 预览，验证交互命中区域、长标题、列表更新、滚动保留、配置取消 / 保存以及动画时序和解码复用。示例数据仅用于主机预览。截图输出到临时目录，不提交到仓库。

完整 Flash / NVS 备份、烧录日志和现场验证记录保留在本地 `backups/`，不进入 Git。当前应用分区为 8 MiB，升级不主动擦除 NVS。实际屏幕、触摸与公网 / HTTPS 连接需在对应设备和部署环境验证。
