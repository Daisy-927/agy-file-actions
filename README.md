# 文件与链接操作 · File Actions for Antigravity

适用于 **Google Antigravity（Windows 桌面端）** 的聊天文件与链接右键菜单增强插件。

> **Author / Ported by**: **Gemini 4 Hydrogen**  
> **Upstream**: 基于开源项目 [jidekaixin2dian/dsh-file-actions](https://github.com/jidekaixin2dian/dsh-file-actions)（MIT License）适配移植。

![文件与链接操作 · File Actions 效果预览](assets/preview.png)

---

## 功能特性

- **原汁原味 Codex / DSH 风格右键菜单**：在 Antigravity 聊天区中的以下内容上右键即可呼出：
  - `file:///`（含 `#L10` / `#L10-L20` 行号范围）与 `vscode-file://` / `antigravity://file/` 链接
  - 行内 `<code>...</code>` 文件名或路径
  - 产出卡片 / 文件芯片（如 `Edited server.mjs +4 -1` 及芯片内图标）
  - 本地图片预览与普通 `http(s)://` 网页链接
- **打开与打开方式**：默认应用直接打开、自动识别已安装编辑器（Antigravity / VS Code / Cursor / Notepad++ / 记事本等）、读取 Windows 注册表关联应用与真实图标并支持搜索，以及按扩展名收藏**首选应用**。
- **资源管理器定位 & 多维度复制**：在资源管理器中高亮定位、复制绝对路径、相对路径、文件名、完整引用、文件内容（2 MiB 内有效 UTF-8）、引用行与**片段及来源**。
- **预览能力**：
  - 图片 / SVG 缩略图及大图灯箱；支持视频首帧缩略图。
  - 行号引用上下文只读弹窗（高亮引用行，支持前后 4 / 8 / 16 行）。
  - **在浏览器中打开**：通过独立沙盒化的 Electron 预览窗口打开 HTML / SVG / PDF / 图片 / 音视频 / 文本（HTML 与 SVG 默认安全沙盒禁用脚本与外部联网，可按需手动点击“信任此文件”）。
- **Sidecar 设置与近期产出面板**：可在 AGY 侧栏打开「File Actions」面板调整菜单显示（完整 / 精简）、引用前后文行数、管理首选应用并快速浏览近期产出文件。

---

## 环境要求

- **操作系统**：Windows（当前关联应用发现与 Explorer 定位仅针对 Windows 实现）
- **Node.js**：`>= 22.0.0`（使用了内置 `node:sqlite` 与原生 `WebSocket`）
- **PowerShell 7 (`pwsh`)**（用于运行 `install.ps1`）

---

## 安装与使用

### 方式一：Electron 无感注入（推荐，需前置 `DWrite.dll` 引导）

> **说明**：新版 Antigravity 默认直接启动 `resources/app.asar` 并忽略 `resources/app/index.cjs`，除非安装目录中存在用于引导 `index.cjs` 的 `DWrite.dll`（例如已经安装了 `agy-model-inspector`）。  
> 如果你的 Antigravity 安装目录中还没有 `DWrite.dll`，可以先参考 `agy-model-inspector` 放置 `DWrite.dll`，或改用下方的 **方式二（CDP 模式）**。

在项目根目录执行：

```powershell
# 安装（将插件复制到 ~/.gemini/config/plugins/agy-file-actions，并在 resources/app/index.cjs 追加共存加载块）
pwsh ./install.ps1

# 卸载
pwsh ./install.ps1 -Uninstall
```

安装完成后，**完全退出 Antigravity 并重新打开一次**即可生效。  
不会修改 `app.asar`，且可与 `agy-model-inspector` 共存。

### 方式二：CDP 模式（无需 `DWrite.dll`，不改动 Antigravity 安装目录）

如果你不想改动安装目录下的任何文件，可以使用远程调试端口启动 Antigravity，再运行 CDP 注入脚本：

```powershell
# 1. 启动 Antigravity 时加上调试端口参数，例如：
Antigravity.exe --remote-debugging-port=9222

# 2. 运行 CDP 注入桥接（后台持续监听新打开的会话窗口）
node --no-warnings ./scripts/runtime-injector.mjs
```

---

## 目录结构

- `vendor/dsh-file-actions-client.js`：复用自 `jidekaixin2dian/dsh-file-actions`（MIT，保持上游核心不变）
- `scripts/agy-file-actions-overlay.js`：Antigravity 主题适配（支持浅色/深色及 `oklch` 变量）、DOM 载体识别增强与零轮询 `waitRequest` RPC 桥接
- `scripts/windows-file-ops.mjs`：Windows 文件定位、`conversation_summaries.db` 工作区与 `brain/` 目录解析、分块读取、注册表关联应用与图标查询
- `scripts/electron-overlay-loader.cjs`：Electron 主进程加载器与沙盒浏览器预览服务
- `scripts/runtime-injector.mjs`：CDP 模式兜底注入脚本
- `sidecars/panel/`：Antigravity Sidecar 设置与近期文件面板
- `test/`：单元测试与无头 Edge E2E 测试

## 运行测试

```powershell
npm test
```

## 致谢与许可

- 本项目采用 [MIT License](LICENSE)。
- 移植与适配编写：**Gemini 4 Hydrogen**。
- 原始创意、菜单交互与前端核心代码来自 [jidekaixin2dian/dsh-file-actions](https://github.com/jidekaixin2dian/dsh-file-actions)（MIT License）。
- 无 `app.asar` 修改的侧载 `index.cjs` 引导思路参考自 `agy-model-inspector`。
