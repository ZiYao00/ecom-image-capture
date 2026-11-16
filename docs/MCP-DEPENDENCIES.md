# Chrome MCP / Eagle MCP｜公开版依赖契约

## 基本原则

用户只需本仓库 + Node.js + Google Chrome + Eagle 桌面程序。**不需要 CodexPro、WorkBuddy、local-service-control 或 AI-Runtime 仓库。** Chrome MCP 由本项目的 `package.json` / `package-lock.json` 锁定并安装到本项目的 `node_modules`；Eagle MCP 通过 Eagle 官方插件安装在 Eagle 应用内。两个桌面应用不打包进开源源码。

## Chrome MCP（项目内依赖）

- 官方源码：https://github.com/ChromeDevTools/chrome-devtools-mcp
- 本项目固定：`chrome-devtools-mcp@1.11.0`（此前 PC1 测试所用的版本）；升级须测试 `new_page`、`list_pages`、`evaluate_script` 等工具兼容性。
- 安装：在项目根运行 `npm ci`。不允许每次采集调用 `npx ...@latest` 或用户复制其他项目的安装路径。
- 默认浏览器模式：`chromeMode=project`。项目调用 `scripts/browser.mjs start` 启动电脑上已有的 Chrome，使用 `runtime/chrome-profile` 作为**本项目独立登录目录**，通过仅监听 `127.0.0.1:9222` 的 CDP 连接。用户自行完成网站登录。
- 项目通过 `node_modules/chrome-devtools-mcp/package.json` 的 `bin` 字段定位 Chrome MCP；配置与命令均不应硬编码第三方工程路径。
- 备选 `chromeMode=autoConnect`：适用于已有 Chrome 144+，要求用户主动启用远程调试并在浏览器授权；**与项目独立 Profile 模式二选一**，不静默切换。
- `chromeMode=shared`：仅保留给已存在的 PC1 自用环境作为兼容选项，不属于公共版首次安装流程。
- 安全边界：Chrome CDP 仅监听回环地址；不共享、复制、上传用户的浏览器 Profile、Cookie、登录凭据。

## Eagle MCP（Eagle 内的官方插件）

- 官方插件：https://community-cn.eagle.cool/plugin/mcp-server
- 开发者：Eagle App，验证版本：`0.3.1`；插件要求 Eagle 4.0 Build 12 或以上。
- 安装：用户先安装并打开 Eagle 桌面版，在 Eagle 的插件中心安装 **MCP Server**，按 Eagle 官方步骤开启 MCP 服务。
- 本项目默认连接 `http://127.0.0.1:41596/mcp`。这不是 Eagle 基础 Web API 的 `41595` 端口；不要混用。
- 项目通过 MCP `initialize` → `tools/list` → `get_app_info` 进行只读健康检查；**必须存在** `item_add`、`item_get`、`get_app_info` 才宣告采集就绪。
- 常规图片采集**只使用 Eagle MCP 的 `item_add`**；脚本直连仅用于已确认少量缺失且同商品累计 ≤10 张的异常补救，不得变成主下载器。
- 目前不将官方 Eagle 插件本体随 ZIP 再分发，也不创建兼容性未经证明的第三方 Eagle MCP 替代品。

## 可选后处理

- **HTML**：只有 Node.js，本项目默认生成 `detail/HTML.html`。
- **OCR**：项目自有隔离目录 `runtime/ocr/.venv` 和 `requirements-ocr.txt`；用户可主动运行 `node scripts/setup-ocr.mjs --install`。需要 Windows Python 3；不依赖外部 `AI-Runtime` 目录。现有 PC1 `shared` 模式仍允许临时使用旧的共享 OCR 环境。
- **FFmpeg**：只用于明确请求长图拼接，属可选系统依赖；普通图片采集不需要。

## 推荐统一安装与验证（Agent 和普通用户）

Node.js 已安装时，直接使用统一 CLI（适合受限 Agent 宿主）：

```powershell
node scripts/ecom.mjs setup
.\ecom.cmd doctor
.\ecom.cmd capture "<完整商品链接>"
```

仅在检查缺失的系统软件时使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly`。授权 Agent 安装缺失系统软件后才可显式使用 `-InstallSystemDependencies`；安装脚本不会替用户完成网站登录或修改 Eagle 插件权限。统一 CLI 在项目内处理 `npm ci`、Chrome 启动、Eagle 只读预检和采集。

## 原始单步命令（兼容）

```powershell
npm ci
node scripts/setup.mjs
node scripts/browser.mjs start
# 在刚打开的专用 Chrome 中正常登录天猫
# 打开 Eagle 并启动官方 MCP Server 插件
node scripts/check-environment.mjs
node scripts/capture.mjs "<用户提供的完整商品URL>"
```

完整 Windows 安装指南见 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)。**项目内聚**不等于将第三方应用的可执行文件复制进本仓库；这是因为两套桌面应用及其登录/素材库属于用户自己的安装与私有数据。
