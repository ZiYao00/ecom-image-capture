# Windows 安装与跨机部署｜面向普通用户

本项目不是 Chrome 或 Eagle 桌面软件的重新分发包。用户只需下载本仓库，不需要作者个人电脑的任何其他项目。

## 一、必需的三个软件

| 必需软件 | 官方入口 | 用途 |
|---|---|---|
| Node.js ≥20.19 | https://nodejs.org/ | 执行本项目 CLI；本地安装 Chrome MCP 依赖 |
| Google Chrome（桌面版） | https://www.google.com/chrome/ | 完整商品页面及登录会话 |
| Eagle ≥4.0 Build 12 + 官方 MCP 插件 | https://community-cn.eagle.cool/plugin/mcp-server | 图片实际下载、入库和验证 |

**Chrome MCP**：官方 https://github.com/ChromeDevTools/chrome-devtools-mcp ，项目固定 `chrome-devtools-mcp@1.11.0`。通过 `npm ci` 仅装在本项目的 `node_modules/` 下。版本升级必须先通过端到端回归。

**Eagle MCP**：Eagle App 官方 `MCP Server` 插件（已验证 `0.3.1`），由用户在 Eagle 插件管理界面安装并启动。默认本机地址为 `http://127.0.0.1:41596/mcp`，不可与 Eagle 的 `41595` Web API 混用。无需安装第三方 Python Eagle MCP，也无需外部 MCP 框架。

## 二、Agent / 普通用户统一安装（推荐）

**推荐 Agent / 已安装 Node.js 的 Windows 用户**在项目目录直接运行：

```powershell
node scripts/ecom.mjs setup
```

这个入口已经在 PC1、PC2 独立部署中验证，无需通过额外的 PowerShell 子进程。若要检查缺失的系统软件，请先运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly
```

在明确授权系统软件安装后，才运行带 `-InstallSystemDependencies` 参数的安装器。

安装器执行本机依赖检测，并在 Node.js、Chrome、Eagle 存在时自动运行项目内 `npm ci`、`setup.mjs`、专用 Chrome 启动和 MCP 连接检查。Windows PowerShell 使用受控 Node 子进程，诊断日志位于项目内 `runtime/installer-logs/`（已排除 Git 和 ZIP）。缺少系统组件时返回结构化的 `needs_action`；已经授权 Agent 安装系统软件时可以显式加上 `-InstallSystemDependencies`，使用 winget 的精确软件包 ID `OpenJS.NodeJS.LTS`、`Google.Chrome`、`ogdesign.Eagle`。不会静默安装或重试失败的安装。系统软件可能要求用户批准 UAC，Eagle 官方 MCP 插件可能仍需在 GUI 中启用。

初始化后的日常使用：

```powershell
.\ecom.cmd doctor
.\ecom.cmd capture "<完整天猫商品链接>"
.\ecom.cmd scan "<完整天猫商品链接>"  # 不调用 Eagle
.\ecom.cmd list
```

CLI JSON 状态：`ready`（依赖就绪）、`needs_action`（缺少插件/浏览器/需要人为操作）、`completed`（命令完成）、`failed_no_automatic_retry`（必须检查回执，不能盲目再次导入）。退出码 `0/10/2`。

### 旧命令兼容（高级用户）

以下命令仍然保留，普通用户无需逐条执行。

## 三、底层安装步骤

从 GitHub 下载源码 ZIP 并解压，使用 Windows PowerShell 或终端进入目录：

```powershell
cd C:\AI\ecom-image-capture  # 示例路径；可放在任意可写目录
npm ci                         # 安装固定版本 Chrome DevTools MCP
node scripts/setup.mjs         # 创建本机配置、空商品索引、output/
node scripts/browser.mjs start # 启动本项目专用 Chrome
```

首次运行会建立独立 `runtime/chrome-profile/`；登录天猫后保持 Chrome 窗口开启。登录配置属于用户个人，不在 ZIP 和 Git 提交范围内。用户如果已有 Chrome，项目会使用现有 Chrome 程序，不会自动安装另一份 Chrome。

在 Eagle 中安装并打开 **MCP Server** 插件，确保有打开的 Eagle 素材库。然后检查：

```powershell
node scripts/check-environment.mjs
```

`readiness.capture=true` 才可正式采集。检查仅执行只读 MCP 握手，不导入 Eagle 图片。

```powershell
node scripts/capture.mjs "<用户粘贴的完整天猫商品URL>"
```

默认 `storageMode=copy` 会生成 `output/商品ID/main`、`detail`、`detail/HTML.html`；如在本机 `config/local.json` 配置 `storageMode: "eagle"`，原图仅归档到 Eagle，项目保留索引/回执，不复制整套图片，也不生成依赖副本的 HTML。Eagle 插件可直接连续预览；需要长图时用 `ecom stitch-eagle <商品ID> [宽度]` 直接读取 Eagle 原图并仅把长图存回 Eagle。已有回执不自动重新提交 Eagle。

## 三、可选功能

### OCR

不需要作者的共享 `AI-Runtime` 工程。可选地在**本项目内部**建立独立 Python 环境（需要电脑已经安装 Python 3）：

```powershell
node scripts/setup-ocr.mjs --install
node scripts/ocr.mjs --product 1050012712486
```

OCR 使用本项目 `requirements-ocr.txt`，环境位于 `runtime/ocr/.venv`，未调用 `--install` 不会自动安装。OCR 未配置不影响图片采集或 HTML。

### 长图

仅明确要求长图时需要 FFmpeg/FFprobe，普通采集不依赖它们。可以通过 `STITCH_FFMPEG` / `STITCH_FFPROBE` 或本机 `config/local.json` 的 `ffmpegExecutablePath`、`ffprobeExecutablePath` 指向已安装的可执行文件。部分动画 WebP 需要 FFmpeg 9+；不要直接替换 Eagle 自带的 FFmpeg 插件二进制。

## 四、故障排查

- 报错 `Project Chrome DevTools MCP missing`：在项目目录执行 `npm ci`，检查网络与 `node_modules`。
- 报错 `Project Chrome unavailable`：执行 `node scripts/browser.mjs status`，然后 `start`；如果端口占用，改本机配置 `chromeDebugPort`（默认 9222），不要占用其他 Chrome。
- Eagle MCP 无法连接：检查 Eagle 已启动、插件已经启用、所需工具 `get_app_info`、`item_add`、`item_get` 可见。
- 图片页面访问异常：保持完整原始 URL，在专用 Chrome 正常检查并登录；不自动绕过验证码/安全验证。
- 任务中断：根据 `data/runs/stable-ID/receipt.json` 和 [恢复指南](RECOVERY.md) 接续，不删除回执来重新入库。

## 五、旧 PC1 兼容与发布包

已有 `chromeMode=shared` 的电脑继续按其原配置运行；**新安装默认 `chromeMode=project`，没有跨项目依赖。**

发行 ZIP 必须只包含经过筛选的源码、文档、测试、`package.json`、`package-lock.json` 和 OCR requirements。不能包含 `node_modules`、浏览器 Profile、Eagle 数据、`config/local.json`、`data/captures.json`、运行日志、历史图片或临时文件。

**最低独立验收**：在与开发电脑配置不同的 Windows 环境里成功 `npm ci`、启动专属 Chrome、启用 Eagle 官方 MCP、采集一个新商品，并按本机实际 `storageMode` 检查 Eagle itemId、实体文件及主图/详情分类；`copy` 模式还应验证本地副本/离线 HTML，`eagle` 模式应验证手机预览插件与 Eagle 原图直读长图拼接。未完成跨机真实端到端验收和 GitHub CI 检查前只能称候选版，不能声称正式稳定版。

详细依赖与安全边界见 [MCP-DEPENDENCIES.md](MCP-DEPENDENCIES.md)。
