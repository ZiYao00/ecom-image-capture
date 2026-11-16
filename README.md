# ecom-image-capture｜天猫商品图片采集

**独立 Windows CLI**：Chrome DevTools MCP 扫描完整商品页面 → Eagle 官方 MCP 插件批量采集与校验 → 分类复制到本机 → 默认生成离线 `detail/HTML.html`。可选 OCR 和长图拼接。

本项目**不依赖 CodexPro、WorkBuddy、local-service-control 或 AI-Runtime**。Chrome MCP 是本仓库自己的 npm 依赖；Eagle MCP 是 Eagle 桌面程序内安装的官方插件。需要 Windows、Node.js ≥20.19、Google Chrome、Eagle（含 MCP Server 官方插件）。当前只适配已测试的天猫商品页面，非全平台通用采集器。

## 首次安装：一条入口

下载本项目源码或 Release ZIP 并解压。**电脑已安装 Node.js 时，用户或 Agent 只需在项目目录执行：**

```powershell
node scripts/ecom.mjs setup
```

它会安装固定版本 Chrome MCP、初始化本机配置、启动项目专用 Chrome，并检测 Eagle MCP。也可以运行 `.\ecom.cmd setup`。**不会自动安装系统软件或替用户登录账号。**

如果 Node.js 尚未安装，先运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly` 检查系统依赖，或在获得安装授权后使用下方 winget 入口。Windows PowerShell 包装入口为可选路线，受限 Agent 宿主优先直接调用 Node CLI。

已有安装授权的 Agent 可显式启用系统依赖安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallSystemDependencies
```

仅在缺少系统依赖时，才调用 Windows winget 安装 Node.js LTS、Google Chrome 或 Eagle 桌面程序。Eagle 官方 MCP Server 插件仍需在 Eagle 中启用，首次访问天猫需在专用 Chrome 中正常登录。

程序返回结构化 JSON：`ready` / `needs_action` / `failed`，Agent 根据 `nextActions` 精确处理，不依赖理解历史经验文档。

随后只需：

```powershell
.\ecom.cmd doctor
.\ecom.cmd capture "完整天猫商品链接"
```

所有采集都保留用户原始完整 URL。无需复制作者的 Chrome Profile、Eagle 库或其他本地工程。

## 默认输出

```text
output/
└── 商品ID/
    ├── main/
    │   └── 01.jpg ...
    ├── detail/
    │   ├── 01.jpg ...
    │   └── HTML.html
    ├── 商品ID-主图文案.txt        # 可选 OCR
    └── 商品ID-详情页文案.txt      # 可选 OCR
```

路径优先级：显式命令参数 > `ECOM_OUTPUT_ROOT` > `config/local.json.outputRoot` > `output/`。旧商品使用登记过的原始输出路径，不自动迁移。

## 操作命令（用户与 Agent 共用）

```powershell
.\ecom.cmd setup                          # 幂等安装/初始化/环境检查
.\ecom.cmd doctor                         # 只读诊断
.\ecom.cmd capture "<完整原始链接>"          # 自动准备浏览器，Eagle 主采集 + HTML
.\ecom.cmd capture "<完整原始链接>" "D:\项目素材"
.\ecom.cmd scan "<完整原始链接>"             # 仅扫描页面，不入库
.\ecom.cmd list                           # 查看历史采集
.\ecom.cmd html 1050012712486
.\ecom.cmd ocr-install                    # 按需安装本项目 OCR 依赖
.\ecom.cmd ocr 1050012712486
.\ecom.cmd browser start
.\ecom.cmd resume 1050012712486          # 仅符合安全回执条件时显式恢复
```

所有命令都有 JSON 输出，成功退出码 `0`，需要用户/Agent 操作时 `10`，失败且不可盲目重试时 `2`。需要脚本集成时也可直接运行 `node scripts/ecom.mjs ...`。底层原始脚本继续保留供高级维护。

**Eagle 是唯一常规图片下载/归档工具。** 只允许对 Eagle 已提交但确认少量缺失的商品，通过独立恢复命令补图，同一商品任务累计 **最多 10 张**。不得在状态不确定时重复提交 `item_add`。不修改原图，保留 GIF 动画；长图拼接仅在明确要求时进行。

## 文档

- [Chrome/Eagle MCP 安装、版本和连接要求](docs/MCP-DEPENDENCIES.md)
- [完整 Windows 安装及跨机部署](docs/INSTALL-WINDOWS.md)
- [采集与交付强制规则](docs/PIPELINE-RULES.md)
- [安全恢复和故障诊断](docs/RECOVERY.md)
- [GitHub 公开发布清单](docs/GITHUB-RELEASE.md)
- [Agent 执行规范](AGENTS.md)
- [English README](README.en.md)

`chromeMode=project` 是新用户默认模式，浏览器专用 Profile 保存在被 Git 忽略的 `runtime/chrome-profile`。既有 PC1 可继续使用 `chromeMode=shared` 作为历史兼容模式，无需切换。所有登录信息、图片、配置、回执和下载依赖目录均不进入 GitHub。

项目目前是技术测试阶段。GitHub 正式发布前还需经独立干净 Windows 环境完整采集验收。
