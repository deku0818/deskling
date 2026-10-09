# Deskling

[GitHub](https://github.com/deku0818/deskling) · [CI](https://github.com/deku0818/deskling/actions/workflows/hub.yml) · [Docker Hub](https://hub.docker.com/r/ycw0818/deskling-hub)

Codex / Claude Code 桌搭：在一块 480×480 触摸屏上显示所选来源的会话状态、吉祥物和剩余额度。点击时钟进入配置，选择来源后保存；两边的数据分别存储和订阅。吉祥物与来源无关，两边共用同一只宠物（默认 Clawd）。硬件为微雪 ESP32-S3-Touch-AMOLED-2.16，网页用于预览和调试。

- [宠物包设计](docs/PET_DESIGN.md)：宠物包格式、生成方式，以及固件和网页的播放方式
- [历史设计文档](docs/archive/HUB_DESIGN.md)：早期服务端、采集端和显示协议方案
- [web/index.html](web/index.html)：显示端页面，可连接 Hub 显示实时数据，也保留演示情景
- [firmware/README.md](firmware/README.md)：ESP32-S3 AMOLED 显示端的编译、配网与硬件验证

```
Claude Code ─ Hooks / get_usage ─▶ collector ─┐
                                           ├─HTTP─▶ 一个 Hub ─WebSocket─▶ 网页 / ESP32
Codex ─ Hooks / App Server / 本地事件 ────────┘          按 provider 分别订阅
```

## 仓库结构

```text
web/                   网页显示、设备模拟预览与真实配网页面
hub/                   Hub 服务、模拟数据上报工具与测试
collector/             Claude Code / Codex 采集与安装脚本
firmware/              ESP32 固件、原生 UI 预览与协议测试
assets/                网页与固件共用的宠物包（assets/pets）、字体及来源说明
scripts/               共享素材重建工具
docs/archive/          历史方案记录
```

网页通过 Hub 打开；只看模拟界面时，可在仓库根目录运行 `python3 -m http.server 8765`，访问 `http://127.0.0.1:8765/web/`。真实数据和设备配置需要 Hub。

## 启动 Hub

需要 Node 22.18 或更高版本，Hub 直接运行 TypeScript，无需编译。

```bash
npm --prefix hub ci
```

```bash
cp hub/.env.example hub/.env
```

把 `hub/.env` 中的两个令牌换成随机值，例如用 `openssl rand -hex 24` 生成。

```bash
npm --prefix hub start
```

Hub 会在局域网中通过 mDNS 广播 `_deskling._tcp`，可以用 `dns-sd -B _deskling._tcp` 查看；部署到公网时在 `.env` 中设置 `MDNS=0`。

浏览器打开 `http://<Mac 的局域网地址>:8787/?token=<DISPLAY_TOKEN>`。令牌保存在浏览器后会从地址栏移除，之后直接打开 `http://<地址>:8787/` 即可。

## 用模拟数据试一下

```bash
npm --prefix hub run simulate
```

模拟器循环播放三个会话的工作、等待确认、出错和完成过程。加 `-- --once` 只播放一遍，加 `-- --speed 3` 加快速度。

## 接入真实的 Claude Code

```bash
node collector/install.mjs --hub http://127.0.0.1:8787 --token <INGEST_TOKEN> --source mac
```

安装脚本会：

- 把采集脚本复制到 `~/.deskling/bin`，配置写入 `~/.deskling/config.json`
- 记录本机 `claude` 的绝对路径，用于读取账号额度；找不到时可以用 `--claude <路径>` 指定
- 在 `~/.claude/settings.json` 中追加 Deskling 的 Hooks，不改动已有 Hooks，修改前自动备份

已经打开的 Claude Code 会话需要重启后才会生效。卸载：

```bash
node collector/install.mjs --uninstall
```

## 接入真实的 Codex

先完成上述采集端安装（配置和令牌共用），再执行：

```bash
node collector/install-codex.mjs
node ~/.deskling/bin/deskling-codex.mjs
```

安装会追加 `~/.codex/hooks.json`，保留其他 Hooks 并备份原文件。首次需要在 Codex 的 `/hooks` 中审阅并信任 Deskling 的钩子；这是 [Codex 官方的 Hooks 信任流程](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)。安装器不会更改信任记录或权限策略。已有会话按 Codex 的配置加载机制重新加载后生效。

采集进程每 5 秒检查本机未归档的根会话，每分钟通过 `account/rateLimits/read` 读取额度；不恢复会话、不发送模型请求、不读取或复制登录凭据。官方 Hooks 提供权限等待、恢复、完成和中断事件；尚未信任 Hooks 时，通过本地事件记录补充工作和完成状态，权限等待可能无法准确识别。事件记录适配层集中在 `collector/codex.mjs`，格式跟随本机 Codex 版本维护。

额度按 `windowDurationMins` 匹配 5 小时和周窗口。未返回的窗口显示 `--`，Codex 不显示 Fable。只采集简短标题和状态，不上传完整对话或工具内容。当前不自动监控远端 SSH / 云端 Codex 会话。

保持该采集进程运行。可使用系统服务管理器托管；运行一次用于诊断：

```bash
node ~/.deskling/bin/deskling-codex.mjs --once
```

macOS 推荐安装后台服务，关闭手动启动的采集进程后执行：

```bash
node collector/install-codex-service.mjs
```

服务立即启动，登录后自动运行，退出后自动重启，每分钟更新额度。重新运行安装命令可更新服务及采集脚本，不会修改 Hooks 或信任记录。日志在 `~/.deskling/logs/codex-collector*.log`。会话 Hooks 与额度采集独立；只有 Hooks 在运行时，会话仍可更新，但额度会停留在上次读数。

卸载后台服务：`node collector/install-codex-service.mjs --uninstall`。卸载 Codex 钩子：`node collector/install-codex.mjs --uninstall`，并停止手动启动的采集进程。Claude 的卸载命令独立生效。

## 来源与显示协议

- `/ws?provider=claude` 或 `/ws?provider=codex`，沿用 `DISPLAY_TOKEN` 鉴权。
- `/snapshot?provider=codex` 可读取对应快照。省略来源时默认为 Claude；未知来源返回错误。
- 快照 v2 包含 `provider`；两边的会话、优先级、额度、采集端和去重数据分别维护。
- 旧采集端没有 `provider` 时归入 Claude；旧 Hub 状态自动迁移到 Claude，不复制到 Codex。
- 网页与设备各自保存来源，切换不影响另一台显示端。切换时清空上一来源，再接收所选来源快照。
- `web/index.html` 是统一的显示与模拟预览入口；`web/setup.html` 是真实设备配置页。Hub 仍通过 `/` 和 `/setup.html` 提供访问。

## 开发

```bash
npm --prefix hub test
```

```bash
npm --prefix hub run typecheck
node --test collector/*.test.mjs
```

## Docker

预构建镜像：[ycw0818/deskling-hub](https://hub.docker.com/r/ycw0818/deskling-hub)，同一个标签支持 `linux/amd64`（x86_64）和 `linux/arm64`（ARM64）。Docker 会按主机架构选择镜像。镜像包含 Hub、显示页面和设备配置页。

按前文准备 `hub/.env` 并替换令牌后启动：

```bash
docker run -d --name deskling-hub --restart unless-stopped \
  -p 8787:8787 -v deskling-data:/data \
  --env-file hub/.env -e MDNS=0 \
  ycw0818/deskling-hub:0.1.0
```

也可以在仓库根目录自行构建两种架构：

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f hub/Dockerfile -t deskling-hub:0.1.0 --load .
```

本地保存多架构镜像需要 Docker Desktop 开启 containerd 镜像存储。

容器默认关闭 mDNS（`MDNS=0`），因为容器网络收不到局域网广播。

```bash
docker run -d --name deskling-hub -p 8787:8787 -v deskling-data:/data -e INGEST_TOKEN=... -e DISPLAY_TOKEN=... deskling-hub
```

额度由各台机器上的采集端读取并上报，镜像中不需要 `claude`。

### GitHub CI 与镜像发布

`.github/workflows/hub.yml` 运行 Hub 测试、TypeScript 检查和采集端测试，全部通过后构建 AMD64 / ARM64 镜像。发布后逐架构检查健康接口、页面、素材、来源快照和 USB 枚举。PR 只验证构建；`main` 更新发布 `latest` 与 `sha-<提交>`，`v*` 标签发布对应版本（例如 `v0.1.0` → `0.1.0`）。也可在 Actions 页面手动运行。

发布仓库需要 Actions Secret `DOCKERHUB_TOKEN`（Docker Hub Read & Write Access Token）和 Actions Variable `DOCKERHUB_USERNAME`（默认 `ycw0818`）。凭据只存在于 GitHub Secrets，不写入代码。未配置 Token 时 CI 只构建、不推送。

### 公网访问：HTTP 或 HTTPS

**直接 HTTP**：没有域名或只是测试时，在服务器安全组中放行 8787 端口，采集端、浏览器和 ESP32 都填 `http://<服务器公网 IP>:8787`。不需要额外配置。

这种方式下，令牌、会话标题和额度都以明文传输，网络路径上的任何人都能看到；拿到上报令牌的人还可以伪造会话状态。只建议用于测试，或者你能接受这些风险的场景。

**HTTPS（推荐）**：有域名时，在 Hub 前面加一个反向代理，例如 Caddy，它会自动申请证书。地址改填 `https://<域名>`，网页和 ESP32 会自动改用 `wss://`。Hub 本身不需要改动。

## 设备配置

Hub 启动后，在这台电脑打开 [设备配置](http://127.0.0.1:8787/setup.html)，或从主界面时钟 → 配置 → 网络设置进入。接上 USB 数据线，点击“连接 Deskling”，选择 2.4GHz Wi-Fi 并输入密码。选择“本机 Hub”时，Hub 自动下发本机地址和独立设备凭证；选择“远程 Hub”时填写 HTTP(S) 基地址，通过远程服务器配对或粘贴其显示 Token。设备验证连接成功后保存；修改当前网络时密码留空可保留，失败保留原配置。关闭串口监视器后再使用 USB 管理。

手机配网在同一页面点“用手机配置”，设备点击网络设置后扫描 Wi-Fi 二维码，手机选择网络并输入密码，最后在 Hub 核对配对码并确认。配对窗口五分钟有效；设备凭证只允许读取快照。

USB 管理只开放给运行 Hub 的电脑，不依赖浏览器 Web Serial。USB 与手机配网页面都支持本机 / 远程 Hub 选择。单独修改 Wi-Fi 保留现有 Hub 凭证，更换 Hub 保留 Wi-Fi。远程目标失败时不会回退到其他局域网 Hub。详见 [固件说明](firmware/README.md)。

### 远程 Hub 配对

在远程服务器启动 Hub，并让设备能访问其 `/snapshot`、`/ws` 与 `/pair/*`。配置页填写 `http://公网IP:8787` 或 `https://hub.example.com`，不加 `/ws`；HTTPS 反向代理需要转发 WebSocket Upgrade。手动 Token 必须来自这个远程 Hub。

配对管理接口保持本机访问。可在电脑建立 SSH 隧道（将用户名和服务器地址替换为实际值）：

```sh
ssh -N -L 8877:127.0.0.1:8787 用户名@服务器公网IP
```

然后打开 `http://127.0.0.1:8877/setup.html?pairing=1`，点击“开启配对”，在设备发出请求后核对配对码并确认。设备等待开启配对最多五分钟，成功后保存由远程 Hub 发放的只读设备凭证。本机 Hub 不会代理远程审批，也不会把本机 Token 发给远程服务器。

以上隧道示例针对直接运行的 Node Hub。Docker 端口映射可能让管理请求来自容器网桥，因此仍会被本机检查拒绝；不要通过开放公网管理接口绕过检查。可在服务器直接运行 Hub 或使用服务器内经过确认的容器本机管理通道。

## 许可证

Deskling 自有代码和文档采用 [MIT License](LICENSE)。第三方字体保留各自的许可证；Clawd 素材来源于 Anthropic，不属于本项目的 MIT 授权范围。素材来源与第三方权利说明见 [NOTICE](NOTICE)。
