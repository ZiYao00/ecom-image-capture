# ecom-image-capture｜Agent 执行约束

> 入口：`README.md`；完整规范：`docs/PIPELINE-RULES.md`；恢复：`docs/RECOVERY.md`。**不需要 Agent 从几十份历史 HANDOFF 中推断规则**。确定性的规则必须由项目脚本和测试强制执行。

## 标准执行（用户已授权的单商品任务）

1. **Agent 首选** `node scripts/ecom.mjs setup`：安装项目内 Chrome MCP、初始化目录和配置、启动独立浏览器并验证 Eagle；不需外部 Agent 工程。命令返回 JSON `status` / `nextActions` 和退出码。只有 Node 未安装或明确需要系统依赖检测时，才从 `install.ps1 -CheckOnly` 开始；系统软件安装必须另获授权后显式使用 `-InstallSystemDependencies`。受限 Agent 宿主不必强制经 PowerShell 进程包装层。缺少 Eagle 插件或网站登录时准确反馈，OCR/FFmpeg 缺失不阻断采集。
2. `ecom.mjs setup` 会幂等调用原 `setup.mjs`，不覆盖已有商品索引和本机配置，也不需要额外重复执行初始化命令。
3. 传入**用户的完整原始天猫 URL**，执行 `node scripts/ecom.mjs capture "<完整URL>" ["<根目录>"]` 或 `.\ecom.cmd capture ...`。CLI 负责浏览器准备、MCP 预检和一次正式采集；禁止删掉 URL 参数，禁止失败后自动重提 Eagle。
4. 默认 `storageMode: copy` 本地输出到 `output/`；用户显式路径优先。`storageMode: eagle` 时不复制本地图片，但仍保存索引与回执；按需 `ecom export <商品ID>`。旧商品输出路径保持不变，不移动或重采。
5. Eagle `item_add` 是图片主采集手段，`item_get` 由脚本自动有限次重查。**Eagle 的「重复添加提示」可能让导入等待选择，即使 MCP 返回成功也未落盘**；必须核对物理文件，不得对不确定的批次自动重发 `item_add`。
6. 直连下载仅限 `recover-direct.mjs` 中的受控例外，**必须 Eagle 已部分验证且同一商品累计不超过 10 张**。不经过 Eagle 查重、Eagle 离线或超过上限时禁止执行。
7. 新商品采集必须自动创建/复用 Eagle 的 `天猫批量采集_YYYY-MM-DD/<ID>/主图|详情页`，分类用已有 itemId 建立文件夹关联并回读；不重发 `item_add`。`receipt.archive.status` 必须单独报告，缺图或分类不完整不得报整体完成。
8. `copy` 模式生成 `main/`、`detail/` 和 `detail/HTML.html`；`eagle` 模式直接通过 Eagle 窗口插件预览，不创建重复素材。OCR 只按需执行；授权长图拼接时首选 `ecom stitch-eagle <商品ID> [宽度] [--check]`，直接读 Eagle 物理原图与哈希，拼接后仅回存成品。`ecom stitch` 为本地副本兼容入口。
9. 历史补图应以 `ecom archive <商品ID> --check` 对账 Eagle 当前实物；保存独立快照，不改原始 receipt。文件缺失或同名/重导入结果不确定时不得重复 `item_add`。
10. 回执不完整、页面访问异常、已有人工 HTML 或旧文件冲突时按 `docs/RECOVERY.md` 选择固定命令，不凭 Agent 猜测处理。只操作当前 Agent 创建并拥有的商品标签页。
11. 项目内目录、配置、锁和历史回执各有所属；不直接修改外部 Chrome Profile 或 Eagle 素材库内部文件；经授权新增/分类 Eagle 素材只使用官方 API，保留原图。统一 setup 可在项目内部自动执行固定版本 `npm ci`，但**系统软件安装仅能在明确授权下通过 `-InstallSystemDependencies`**。不自动处理验证码、账号登录；不执行 Git commit/push、不批量删除历史文件。

## 质量闸门

```powershell
node --test tests/*.test.mjs
node scripts/capture.mjs --self-test
node scripts/check-environment.mjs
```

只有实际运行并通过验证的步骤才能报告为已完成。跨 PC2 部署也必须按 `docs/INSTALL-WINDOWS.md` 验证；不得以 PC1 历史成功代替新电脑验收。