# ecom-image-capture｜天猫商品图片采集

**独立 Windows CLI**：Chrome DevTools MCP 扫描完整商品页面 → Eagle 官方 MCP 批量入库与回读 → 自动创建商品主图/详情页分类并验证。默认 `copy` 保留本地图片和离线 HTML；可配置 `storageMode: eagle` 仅保留 Eagle 原图，通过 Eagle 窗口插件直接预览。OCR 为可选后处理；详情长图在 Eagle 素材完整归档后自动生成并仅回存成品。

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

## 行业自动分类（无需重新采集）

商品标题用于识别一级行业与二级类目；分类的唯一业务来源仍是 `data/captures.json`。**Eagle 实际目录结构已改为 `电商平台批量采集/<行业>/<商品ID>/主图|详情页`**：整体调整商品文件夹的父级，保留商品文件夹 ID、主图/详情子目录 ID、原图与长图 itemId；不复制图片，不移动 Eagle 库底层实体文件。无法确定行业的新商品进入「待分类」。原有 Eagle 智能文件夹和长图标签保留为辅助筛选，不是新的主分类结构。

常用命令：
```powershell
node scripts/ecom.mjs industry --check
node scripts/ecom.mjs industry --list electronics
node scripts/ecom.mjs industry --apply
node scripts/ecom.mjs industry --sync-eagle
node scripts/ecom.mjs industry --set <商品ID> electronics powerbank   # 人工更正、锁定并迁移整个商品文件夹
node scripts/ecom.mjs industry-folders --check                     # 只读核对行业层级
node scripts/ecom.mjs industry-folders --apply <商品ID>             # 只移动单个商品目录
node scripts/ecom.mjs industry-folders --apply --all              # 按分类迁移所有尚未归位商品
node scripts/ecom.mjs industry-folders --rollback <商品ID>         # 只读核对回退条件
# 显式回退：industry-folders --rollback <商品ID> --apply（仅在需要恢复且核验通过时执行）
```

一级行业编码：adult（成人用品）、electronics（3C数码）、apparel（服饰内衣）、beauty、home、food、pets、other。二级类目在 scripts/industry-core.mjs 管理。关键词证据不足则标记 needs_review，第一版不自动调用 LLM。人工更正设置 manualLocked，后续自动流程不可覆盖。

PC2 历史 29 个商品已整体迁移到行业实体目录：成人用品 19、3C数码 8、服饰内衣 2。迁移前的 Eagle 目录 ID/商品图片关联与移动后的读回结果分别保存在 `data/migrations/industry/`。其中 11 个已完成商品的长图在迁移后重新验证为完整；其余 18 个维持原采集完成状态，不冒充完整商品。`industry --apply` 只维护商品级分类记录，目录层级请用 `industry-folders`；手动修改分类 `industry --set` 会同时移动整个 Eagle 商品文件夹。

**跨电脑说明：**上述 29 个商品的迁移和 Eagle ID 只属于 PC2；PC1 的 Eagle 库和商品登记是独立本机数据。通过 Git 合并源码后，不能直接复制 PC2 的迁移快照或在 PC1 无预检地运行批量目录迁移。PC1 先按 `docs/GIT-COLLABORATION.md` 更新代码并独立对账。

## V3.1 实验功能（默认关闭，非正式采集版本）

新增 Eagle 全库原图 SHA-256 索引与内容一致性预检。PC2 已完成五个不同商品的真实 V3 采集测试：150 个图片位置全部通过独立核验（其中 131 张新增、19 张复用已有 Eagle 原图），5 张 750px 详情长图全部完整。2026-11-24 AA 六商品进一步验证 301/301 图片位置、6/6 长图；三个 V2 历史任务保护 32 个已提交位置、补齐 126 个明确未提交位置。V2 `capture` 不受影响。

```powershell
node scripts/ecom.mjs v3-index --check 30              # 只读抽样
node scripts/ecom.mjs v3-index --build                 # 仅写本机 SQLite 索引
node scripts/ecom.mjs v3-prefetch --check <商品ID>      # 无 Eagle 写入，需已有回执
node scripts/ecom.mjs v3-resume --check <商品ID>        # 仅检查零 Eagle 写入的失败任务
node scripts/ecom.mjs v3-resume-partial --check <商品ID> [原始完整URL] # 逐位置安全恢复预检
# 预检通过后才使用 v3-resume-partial --apply；首次 V2 恢复须提供完整原 URL
node scripts/ecom.mjs v3-resume --apply <商品ID>        # 日志证明零提交后，安全继续并完成后处理
```

V3 需要 Node.js 24+；项目 V2 最低要求不变。V3 正式导入命令 `capture-v3 "<完整URL>"` 需本机显式设置 `v3Experimental: true` 才可运行。**当前仍保持 V3 实验模式**：真实新增原图导入、跨商品复用、零提交安全恢复和 V2 历史部分提交恢复已通过 PC2 实测；仍需更广泛的异常写入、并发及跨机器回归才考虑默认切换。V3 的输入缓存、素材库锁和导入事件日志均位于被 Git 忽略的 `data/`。详见 `docs/PIPELINE-RULES.md` 和 `docs/RECOVERY.md`。

## 默认输出（`storageMode: copy`）

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

路径优先级：显式命令参数 > `ECOM_OUTPUT_ROOT` > `config/local.json.outputRoot` > `output/`。旧商品使用登记过的原始输出路径，不自动迁移。选择 `storageMode: eagle` 时，不再自动复制图片或生成依赖本地副本的 HTML；在 Eagle 插件中读取原图。需要 OCR 或外部交付独立图片时使用 `ecom export <商品ID>` 按需导出。新商品自动拼接 750px 长图；历史商品使用 `ecom finish <商品ID>` 先核验完整性再拼接，均直接读取 Eagle 原图，不导出重复切片。

## 操作命令（用户与 Agent 共用）

```powershell
.\ecom.cmd setup                          # 幂等安装/初始化/环境检查
.\ecom.cmd doctor                         # 只读诊断
.\ecom.cmd capture "<完整原始链接>"          # 自动准备浏览器，Eagle 主采集 + 自动归档 + 长图
.\ecom.cmd capture "<完整原始链接>" "D:\项目素材"
.\ecom.cmd scan "<完整原始链接>"             # 仅扫描页面，不入库
.\ecom.cmd batch "链接清单.txt" --check      # 多链接队列只读预检
.\ecom.cmd batch "链接清单.txt" --apply      # 逐单采集，已有回执跳过，异常不重复入库
.\ecom.cmd verify-live 976328773394 --check # 以 Eagle 当前实物与长图验证交付
.\ecom.cmd verify-live 976328773394 --apply # 完整验证后更新本机采集索引
.\ecom.cmd recover-duplicates 976328773394 --check # 全库查重/缺图恢复资格预检
.\ecom.cmd recover-duplicates 976328773394 --apply # 显式安全恢复，≤10 张，不重复提交
.\ecom.cmd list                           # 查看历史采集
.\ecom.cmd migrate-eagle --check            # 只读检查统一根目录迁移
.\ecom.cmd migrate-eagle --apply            # 迁移文件夹，保留原 itemId
.\ecom.cmd recover-eagle 1024881530158 --check # 本地补图回存 Eagle 前检查
.\ecom.cmd recover-eagle 1024881530158 --apply # 回存已核验的本地补图（不确定结果不重试）
.\ecom.cmd finish 1024881530158              # 完整素材补做长图
.\ecom.cmd archive 1100960492994 --check  # 只读检查 Eagle 文件夹归档
.\ecom.cmd archive 1100960492994          # 对已核验素材补分类（不重新下载）
.\ecom.cmd stitch-eagle 1100960492994 --check # Eagle 原图拼接只读预检
.\ecom.cmd stitch-eagle 1100960492994 750   # 直接从 Eagle 拼接，成品回存商品根目录
.\ecom.cmd export 1100960492994           # 按需导出本地副本
.\ecom.cmd html 1050012712486
.\ecom.cmd ocr-install                    # 按需安装本项目 OCR 依赖
.\ecom.cmd ocr 1050012712486
.\ecom.cmd browser start
.\ecom.cmd resume 1050012712486          # 仅符合安全回执条件时显式恢复
```

所有命令都有 JSON 输出，成功退出码 `0`，需要用户/Agent 操作时 `10`，失败且不可盲目重试时 `2`。需要脚本集成时也可直接运行 `node scripts/ecom.mjs ...`。底层原始脚本继续保留供高级维护。

**批量清单**：UTF-8 文本文件，每行一条完整原始天猫商品 URL；也接受 JSON 字符串数组。批量队列顺序处理、逐商品保存回执；已采集成功或已有不完整回执的商品一律跳过，不会自动重新提交；新商品若发生共享服务故障、不确定写入或验收失败，批次熔断并保留后续未开始记录。对少量确认与全库素材完全相同的缺图，可先执行受控 `recover-direct`，再显式使用 `recover-duplicates` 进行内容一致而文件哈希不同的恢复；GIF 动画必须保持帧和时序。最后调用 `finish`、`verify-live --apply` 完成后处理与最新状态回写，原始回执不变。新入口的既有商品安全跳过已实测通过，尚需以全新 URL 清单验证连续采集。

**Eagle 是唯一常规图片下载/归档工具。** `stitch-eagle` 默认不复制一整套本地原始图片；以当前 Eagle 真实文件及 SHA-256 为准，返回已存在结果时不会再提交。历史补图的现状使用 `archive --check` 读取当前 Eagle，不重写初次 receipt。 只允许对 Eagle 已提交但确认少量缺失的商品，通过独立恢复命令补图，同一商品任务累计 **最多 10 张**。不得在状态不确定时重复提交 `item_add`。不修改原图，保留 GIF 动画；新商品图片完整后自动拼接长图；Eagle 缺图或任一提交结果不确定时保留失败状态，不把缺图拼接成假完整。

## Eagle「使用原图」复用与商品图片顺序

新商品在归档时为 `main/detail` 每个逻辑图片位置建立 `data/product-maps/<商品ID>.json`，Eagle 文件夹中镜像 `order -> itemId`。**多个商品可共用同一 Eagle 原图**，原始素材名称不会为新商品改名；长图和手机预览均以商品自己的逻辑位置顺序读取。PC2 与 PC1 的 Eagle itemId 属于各自素材库，不通过 Git 同步映射数据。

```powershell
.\ecom.cmd reconcile-reused 891544196832 --check # 只读核验「使用原图」的历史缺图
.\ecom.cmd reconcile-reused 891544196832 --apply # 仅建映射，不重新导入
.\ecom.cmd map-eagle 891544196832 --check       # 只读检查映射与 Eagle 分类说明
.\ecom.cmd map-eagle 891544196832 --apply       # 保存映射与镜像至分类文件夹说明
```

Eagle 重复弹窗处于未决、itemId 不明、同 URL 对应多个无法区分的原图时，不自动重试入库或猜测复用结果。将「重新编码以避开去重」保留为受控异常补救工具，而不是常规路径。原始回执和其它商品 Eagle 素材保留。

## 文档

- [Chrome/Eagle MCP 安装、版本和连接要求](docs/MCP-DEPENDENCIES.md)
- [完整 Windows 安装及跨机部署](docs/INSTALL-WINDOWS.md)
- [采集与交付强制规则](docs/PIPELINE-RULES.md)
- [Eagle 自动归档、Agent 直读拼接与详情页窗口插件](docs/EAGLE-ARCHIVE-PLUGIN.md)
- [可选共享 FFmpeg、FFprobe、OCR 运行时](docs/SHARED-RUNTIME.md)
- [安全恢复和故障诊断](docs/RECOVERY.md)
- [跨电脑 GitHub 主干、功能分支、PR 与安全同步 SOP](docs/GIT-COLLABORATION.md)
- [GitHub 公开发布清单](docs/GITHUB-RELEASE.md)
- [Agent 执行规范](AGENTS.md)
- [English README](README.en.md)

Eagle 插件：执行 `node scripts/build-eagle-plugin.mjs` 生成 `release/Eagle-Detail-Preview-0.1.2.eagleplugin`。项目的 `html3.html` 同时可以在普通浏览器中作为文件夹详情预览器使用。

`chromeMode=project` 是新用户默认模式，浏览器专用 Profile 保存在被 Git 忽略的 `runtime/chrome-profile`。既有 PC1 可继续使用 `chromeMode=shared` 作为历史兼容模式，无需切换。所有登录信息、图片、配置、回执和下载依赖目录均不进入 GitHub。

项目目前是技术测试阶段。GitHub 正式发布前还需经独立干净 Windows 环境完整采集验收。
