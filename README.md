# 文件与链接操作 · File Actions for Antigravity

适用于 **Google Antigravity（Windows 桌面端）** 的聊天文件与链接右键菜单增强插件。

> **Author / Ported by**: **Gemini 4 Hydrogen**  
> **Upstream**: 基于开源项目 [jidekaixin2dian/dsh-file-actions](https://github.com/jidekaixin2dian/dsh-file-actions)（MIT License）适配移植。  
> **Disclaimer**: 本项目为非官方社区适配插件，与 Google / Antigravity 官方无任何从属或背书关系；使用前请完整阅读下方的**前置条件、升级覆盖风险与使用边界**。

![文件与链接操作 · File Actions 效果预览](assets/preview.png)

---

## 适用环境与前提条件

- **仅支持 Windows（Windows Only）**：目前注册表关联应用查询（`reg.exe`）、资源管理器定位（`explorer.exe` / `shell.showItemInFolder`）及安装脚本均仅针对 Windows 10/11 实现，**暂不支持 macOS 与 Linux**。
- **Node.js**：`>= 22.0.0`（依赖内置 `node:sqlite` 与原生 `WebSocket`）。
- **PowerShell 7 (`pwsh`)**：用于运行 [install.ps1](install.ps1)（不建议使用老旧 Windows PowerShell 5.1）。
- **已验证宿主版本与兼容性声明**：已在 Windows 桌面端 **Google Antigravity `2.34.0` – `2.35.1`**（安装目录 `version` 标识 `44.9.1`）下实测适配；不保证兼容未来的所有 AGY 大版本——如后续官方大版本调整聊天区 DOM 结构、Sidecar 注册机制或 Electron 启动逻辑，部分识别规则或引导方式可能需要同步更新。

---

## 功能特性

- **原汁原味 Codex / DSH 风格右键菜单**：在 Antigravity 聊天区中的以下元素上右键即可呼出：
  - `file:///`（含 `#L10` / `#L10-L20` 行号范围）与 `vscode-file://` / `antigravity://file/` 链接
  - 行内 `<code>...</code>` 文件名或路径
  - 产出卡片 / 文件芯片（如 `Edited server.mjs +4 -1` 及芯片内图标）
  - 本地图片与普通 `http(s)://` 网页链接
- **打开与打开方式**：默认应用打开、自动识别已安装编辑器（Antigravity / VS Code / Cursor / Notepad++ / 记事本等）、只读查询 Windows 注册表关联应用与真实图标并支持搜索，以及按扩展名收藏**首选应用**。
- **资源管理器定位 & 多维度复制**：在资源管理器中高亮定位、复制绝对路径、相对路径、文件名、完整引用、文件内容、引用行与**片段及来源**。
- **多种预览能力**：
  - 图片 / SVG 缩略图及大图灯箱；支持受支持容器视频的首帧缩略图。
  - 行号引用上下文只读弹窗（高亮引用行，支持前后 4 / 8 / 16 行）。
  - **在浏览器中打开**：通过独立沙盒化的 Electron 预览窗口打开 HTML / SVG / PDF / 图片 / 音视频 / 文本。
- **Sidecar 设置与近期产出面板**：可在 Antigravity 侧栏打开「File Actions」面板调整菜单显示（完整 / 精简）、引用前后文行数、管理首选应用并快速浏览近期产出文件。

---

## 安装与卸载（两种方式）

### 方式一：Electron 无感注入（推荐，需前置引导条件）

> [!IMPORTANT]
> **关于 `DWrite.dll` 的重要前置说明**
>
> 1. 现代 Electron 默认直接启动 `resources/app.asar` 并忽略 `resources/app/index.cjs`。只有当你的 Antigravity 安装目录中**已经存在可引导加载 `resources/app/` 的 `DWrite.dll`**（例如你此前已安装过 `agy-model-inspector` 等同款引导器）时，`install.ps1` 写入的 `resources/app/index.cjs` 才会被自动执行。
> 2. **本仓库不内置或分发任何二进制 `DWrite.dll` 文件**。如果你的安装目录中没有 `DWrite.dll`，请使用下方的 **方式二（CDP 模式）**，或自行准备兼容的引导加载器。
> 3. **Antigravity 客户端更新覆盖提醒**：当 Antigravity 官方推送版本更新或覆盖安装时，安装目录下的 `DWrite.dll`、`resources/app/index.cjs` 与 `resources/app/package.json` 极有可能被安装程序清除。你的插件目录（`~/.gemini/config/plugins/agy-file-actions`）与个人设置（`~/.gemini/antigravity/plugin_data/agy-file-actions/`）**不会丢失**，更新后重新恢复 `DWrite.dll` 并再次运行一次 `pwsh ./install.ps1` 即可恢复。

从 [Releases](https://github.com/Daisy-927/agy-file-actions/releases) 下载最新压缩包并解压（或克隆本仓库），在项目根目录执行：

```powershell
# 安装：
# 1) 将插件作为实体目录复制到 ~/.gemini/config/plugins/agy-file-actions
#    （注意：Antigravity 插件扫描器会跳过 NTFS Junction / 符号链接，因此必须使用实体目录）
# 2) 在 <Antigravity>/resources/app/index.cjs 追加独立加载块（保留已有插件加载器，不修改 app.asar）
pwsh ./install.ps1

# 如果 Antigravity 安装在非默认目录，可显式指定路径：
pwsh ./install.ps1 -AntigravityDir "D:\Programs\Antigravity"

# 卸载（移除 index.cjs 中的加载块并删除插件目录；不会触碰 app.asar 或其他插件）：
pwsh ./install.ps1 -Uninstall
```

安装完成后，**完全退出 Antigravity（包含系统托盘常驻进程）并重新打开一次**即可生效。

---

### 方式二：CDP 模式（无需 `DWrite.dll`，零修改安装目录）

如果你不希望向 Antigravity 安装目录写入任何文件，或没有 `DWrite.dll`，可以通过 Chrome DevTools Protocol 注入运行：

```powershell
# 1. 带远程调试端口启动 Antigravity（请仅在受信任的本机单用户环境下启用调试端口）
& "Antigravity.exe" --remote-debugging-port=9222

# 2. 在仓库目录启动 CDP 注入守护进程（自动发现本地 DevToolsActivePort）
node --no-warnings ./scripts/runtime-injector.mjs
```

*(注：仍建议同时将本插件目录放入 `~/.gemini/config/plugins/agy-file-actions` 以启用 Sidecar 侧栏设置面板。)*

---

## 安全与使用边界

请在使用前知悉以下设计限制与安全边界：

1. **只读系统关联，不修改 Windows 注册表**
   - 「打开方式」列表通过 `reg.exe` 只读查询系统扩展名关联并缓存在本地；「设为首选应用」仅保存在插件本地配置中（`~/.gemini/antigravity/plugin_data/agy-file-actions/settings.json` 与客户端 `localStorage`），**不会修改 Windows 系统默认程序**。
   - UWP / Store 应用（`AppX`）仅在作为系统默认打开方式时通过 `shell.openPath` 调用；其它列表项只保留可直接定位到 `.exe` 的 Win32 桌面程序，避免无效点击。
2. **文件读取与复制上限**
   - 「复制文件内容」「复制引用行」「查看引用上下文」仅支持**有效 UTF-8 编码文本，且单文件大小上限为 2 MiB**；超限文件、二进制文件或非 UTF-8 文件会被直接拦截提示。
   - 「另存为…」「在浏览器中打开」与视频缩略图提取采用分块读取，**上限 64 MiB**，并在读取过程中校验文件版本（`mtimeMs:size`），文件在读取期间发生变更时将中止操作。
3. **HTML / SVG 安全预览沙盒**
   - 使用「在浏览器中打开」查看 `.html` / `.htm` / `.xhtml` / `.svg` 时，会在独立的 Electron 沙盒窗口（`sandbox: true`、`nodeIntegration: false`、`contextIsolation: true`）中加载，默认嵌套 `<iframe sandbox="">` 并附带严格 CSP（禁用脚本与外部联网）。
   - 只有当你确认文件可信并手动点击顶部栏「信任此文件，启用脚本与联网」后，才会对该次预览窗口放行脚本。
4. **工作区外文件保护**
   - 不在当前会话工作区或 `~/.gemini/antigravity/brain/<conversationId>` 目录内的文件，会在菜单头部标出 `工作区外` 标签；对其执行复制内容或查看引用上下文前会弹出确认对话框。
5. **不劫持普通文本右键菜单**
   - `file:///` 链接、行内 `<code>` 和明确的文件芯片可直接冷右键呼出菜单；普通正文里的疑似路径需先经过鼠标悬停 `stat` 核实存在后才会接管右键，避免影响日常文字复制。
   - 任何时候按住 **`Shift + 右键`**，都会优先交还给页面原生菜单处理。

---

## 常见问题排查

- **右键没有反应？**
  1. 确认安装或更新后已**完全退出** Antigravity 托盘进程再重启。
  2. 检查 `~/.gemini/antigravity/plugin_data/agy-file-actions/direct_loader_status.json` 是否存在且包含 `"stage": "attached"`；若无此文件，说明 `resources/app/index.cjs` 未被启动（通常是安装目录缺少 `DWrite.dll`，请确认引导环境或改用方式二 CDP 模式）。
- **侧边栏「插件」里看不到 `File Actions`？**
  - Antigravity 插件扫描器会跳过 NTFS Junction / 符号链接。请确认 `~/.gemini/config/plugins/agy-file-actions` 是**实体目录**且包含 `plugin.json` 与 `sidecars/panel/sidecar.json`（使用最新版 `install.ps1` 安装会自动处理），并重启一次 Antigravity 刷新插件列表。
- **为什么安装了其他插件后 `File Actions` 失效了？**
  - 如果其他侧载插件重装时整份覆盖了 `resources/app/index.cjs`，重新运行一次 `pwsh ./install.ps1` 即可重新追加 `AGY_FILE_ACTIONS_LOADER` 加载块（不会影响已有插件）。

---

## 目录结构

- `vendor/dsh-file-actions-client.js`：复用自 `jidekaixin2dian/dsh-file-actions`（MIT，保持上游核心不变）
- `scripts/agy-file-actions-overlay.js`：Antigravity 主题适配（支持浅色/深色及 `oklch` 颜色变量）、DOM 载体识别增强与零轮询主进程 RPC 桥接
- `scripts/windows-file-ops.mjs`：Windows 文件定位、`conversation_summaries.db` 工作区与 `brain/` 目录解析、分块读取、`reg.exe` 关联应用与图标查询
- `scripts/electron-overlay-loader.cjs`：Electron 主进程加载器与沙盒浏览器预览服务
- `scripts/runtime-injector.mjs`：CDP 模式注入脚本
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
