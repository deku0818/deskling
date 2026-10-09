# 网页与设备预览

- `index.html`：统一显示入口，包含 480×480 设备模拟、场景切换、Codex / Claude Code 来源选择和 Hub 实时订阅。
- `setup.html`：真实设备配置，调用 Hub 的 USB 管理和配对接口，需要启动 Hub。

启动方式见[仓库 README](../README.md)。Hub 将这两个页面分别映射到 `/`（或 `/index.html`）和 `/setup.html`，共享资源仍通过 `/assets/` 访问。

只观察模拟界面时，在仓库根目录运行：

```sh
python3 -m http.server 8765
```

打开 `http://127.0.0.1:8765/web/`。页面使用 `../assets/`，兼容 Hub 路由和这个静态预览目录。

正式入口默认使用圆角屏布局：去除内框，顶部和底部内容左右留白 36px，详情页上下留白 32px，宠物大小和位置保持不变。网页模拟屏幕圆角为 56px。

圆角屏样式 demo：打开 `http://127.0.0.1:8765/web/?rounded=1`。可对比原布局和适配后的布局，并调整模拟圆角大小；此模式使用示例数据，不连接 Hub。

设备端生产 LVGL UI 的渲染与交互检查位于 [`firmware/tools/preview/`](../firmware/tools/preview/README.md)。
