# ecom-image-capture｜Agent 执行约束

> 入口：`README.md`；完整规范：`docs/PIPELINE-RULES.md`；恢复：`docs/RECOVERY.md`。**不需要 Agent 从几十份历史 HANDOFF 中推断规则**。确定性的规则必须由项目脚本和测试强制执行。
> **跨电脑 Git/分支/PR/同步**：先读 `docs/GIT-COLLABORATION.md`，再根据当前主机读取存在的 `runtime/agent-guides/PC1-GIT-RUNBOOK.md` 或 `runtime/agent-guides/PC2-GIT-RUNBOOK.md`。本机指南不进入 GitHub；`main` 更新前检查工作树，Git commit 与 push 各自需授权。

## 标准执行（用户已授权的单商品任务）

1. **Agent 首选** `node scripts/ecom.mjs setup`：安装项目内 Chrome MCP、初始化目录和配置、启动独立浏览器并验证 Eagle；不需外部 Agent 工程。命令返回 JSON `status` / `nextActions` 和退出码。只有 Node 未安装或明确需要系统依赖检测时，才从 `install.ps1 -CheckOnly` 开始；系统软件安装必须另获授权后显式使用 `-InstallSystemDependencies`。受限 Agent 宿主不必强制经 PowerShell 进程包装层。缺少 Eagle 插件或网站登录时准确反馈，OCR/FFmpeg 缺失不阻断采集。
2. `ecom.mjs setup` 会幂等调用原 `setup.mjs`，不覆盖已有商品索引和本机配置，也不需要额外重复执行初始化命令。
3. 传入**用户的完整原始天猫 URL**，执行 `node scripts/ecom.mjs capture "<完整URL>" ["<根目录>"]` 或 `.\ecom.cmd capture ...`。CLI 负责浏览器准备、MCP 预检和一次正式采集；禁止删掉 URL 参数，禁止失败后自动重提 Eagle。
4. 批量模式通过 `node scripts/ecom.mjs batch <urls.txt|urls.json> --check|--apply` 进入；顺序采集、不修改原始 URL、已有回执禁止重新采集；显式 V3 批次可在逐位置证据充分时进入受控恢复，每个商品独立记录状态。共享服务异常或结果不确定时批次熔断，后续商品标记 `not_started_due_to_batch_halt`；仅有零 Eagle 写入的明确商品局部扫描失败可继续。失败商品不得直接重跑整单；只在受控恢复后用 `ecom verify-live <ID> --apply` 更新本地索引，不改原始 receipt。
5. 默认 `storageMode: copy` 本地输出到 `output/`；用户显式路径优先。`storageMode: eagle` 时不复制本地图片，但仍保存索引与回执；按需 `ecom export <商品ID>`。旧商品输出路径保持不变，不移动或重采。
6. Eagle `item_add` 按最多 8 张分批提交且记录每批提交状态，`item_get` 由脚本自动有限次重查；遇 Eagle「使用原图」时，先验证已关联原 itemId 和商品级图片序号映射，再计入已完成。既有素材不改名不覆盖。**Eagle 的「重复添加提示」可能让导入等待选择，即使 MCP 返回成功也未落盘**；必须核对物理文件，不得对不确定的批次自动重发 `item_add`。
7. 直连下载仅限 `recover-direct.mjs` 中的受控例外，**必须 Eagle 已部分验证且同一商品累计不超过 10 张**。不经过 Eagle 查重、Eagle 离线或超过上限时禁止执行。
8. 新商品采集必须自动创建/复用 Eagle 的 `电商平台批量采集/<行业>/<ID>/主图|详情页`，分类用已有 itemId 建立文件夹关联并回读；不重发 `item_add`。`receipt.archive.status` 必须单独报告，缺图或分类不完整不得报整体完成。
9. `copy` 模式生成 `main/`、`detail/` 和 `detail/HTML.html`；`eagle` 模式直接通过 Eagle 窗口插件预览，不创建重复素材。OCR 只按需执行；新商品完整归档后自动拼接 750px 长图，既有商品用 `ecom finish <ID>` 验证后续做，直接读 Eagle 原图与哈希并仅回存成品。`ecom stitch` 为本地副本兼容入口。
10. 历史补图应以 `ecom archive <商品ID> --check` 对账 Eagle 当前实物；若已有受控本地补图，可先执行 `ecom recover-eagle <ID> --check`；保存独立快照，不改原始 receipt。文件缺失或同名/重导入结果不确定时不得重复 `item_add`。
11. 回执不完整、页面访问异常、已有人工 HTML 或旧文件冲突时按 `docs/RECOVERY.md` 选择固定命令，不凭 Agent 猜测处理。只操作当前 Agent 创建并拥有的商品标签页。
12. 项目内目录、配置、锁和历史回执各有所属；不直接修改外部 Chrome Profile 或 Eagle 素材库内部文件；经授权新增/分类 Eagle 素材只使用官方 API，保留原图。统一 setup 可在项目内部自动执行固定版本 `npm ci`，但**系统软件安装仅能在明确授权下通过 `-InstallSystemDependencies`**。不自动处理验证码、账号登录；未获各自明确授权不得执行 Git commit/push，不批量删除历史文件。

## V3.1 实验分支约束

当前 V3 已具备本机指纹索引、浏览器一致性预取、哈希复用、单次导入状态机和 Web API 读回。PC2 已通过真实采集、长图核验及 AA 六商品（301 个位置）收尾，其中三个 V2 历史任务保护 32 个已提交位置并补齐 126 个明确未提交位置。零写入恢复使用 `ecom v3-resume --check|--apply <商品ID>`；历史 V2/部分 V3 使用 `ecom v3-resume-partial --check|--apply <商品ID> [原始完整URL]`，首次 V2 恢复须提供原 URL。先刷新索引并通过只读检查；已提交位置只允许精确证据回读，不允许重发。`capture` 默认仍为 V2；`capture-v3` 必须显式设置本机 `v3Experimental:true`，PC2 已通过新 V3 批次真实生产测试：4 个新商品、161 个逻辑位置（149 新增、12 复用）、4 张长图、1 次 FFprobe 超时的仅后处理自动恢复及 BB 4 个来源项快照收尾；仍需独立主机、未知写入及异常场景验收，不能因为 Git 合并而自动启用。
V3 只在 Node.js 24+ 使用内置 SQLite，不能因此抬高 V2 Node 最低版本或自动安装运行时。
禁止读取到旧的 `import_intent` 后重发 Eagle `item/add`；库级锁、独立导入事件日志、原图缓存与商品原回执都属于必须保留的恢复证据。批量可显式追加 `--engine v3`（本机开关开启、Node 24+），默认仍为 V2。队列自动刷新索引、只在持久化证据支持时执行一次受控恢复，完整独立验收后才继续；旧批次或 V3 任务未决、SKU 冲突/未知、活跃商品锁不得绕过。已有完成商品也必须现场验收，不再次提交。若日志已证明全部原图完成，恢复从后处理开始。详情见 `docs/PIPELINE-RULES.md`。

## 来源文件夹收尾

- `ecom source-closeout AA|BB --check` 只读检查；`--prepare` 保存本机来源快照；`--apply <snapshotId>` 只处理已明确验收、列入该快照的来源项。目录名大小写兼容但必须唯一；实际目标以 ID 为准。先核对原图 SHA-256、商品/SKU、目标关联，再解除源目录关联；禁止删除素材。中途新增、未验收或结果不确定的项保留。未知关联写入不得重发。

## 自动行业分类与 Eagle 展示

- 分类使用商品 ID 而非共享 Eagle 图片 ID；商品登记 data/captures.json 是唯一事实来源，不修改历史 receipt 或淘宝 URL。人工更正 manualLocked 必须保留。
- 采集完成及 verify-live --apply 完成时按商品标题自动分类并在已验收的首张 750px 长图上增量设置专用行业标签；失败返回 industrySync 独立结果，不改变采集成功状态。
- PC2 已将 29 个历史商品完整迁移为 `电商平台批量采集/<行业>/<商品ID>/主图|详情页`，采用 Eagle 官方 `folder_update(parentId)`，保留商品 ID、主图/详情目录 ID 和物理原图；未知行业进「待分类」。`eagle-folder-layout.mjs` 负责新旧结构统一解析，任何重复商品 ID 必须拒绝新建。
- Eagle 原生智能文件夹及长图标签仅保留为辅助视图；未经额外授权不得删除。
- 行业实体目录操作：`ecom industry-folders --check [ID]` 只读、`--apply ID|--all` 按 ID 一次移动、`--rollback ID` 只读回退计划（真正回退需要再传 `--apply`）。`ecom industry --set ID industry subcategory` 人工锁定后会同步移动商品实体目录。分类证据不足需待人工确认，不自动调用 LLM。
- 迁移前记录 `data/migrations/industry` 快照（商品/主图/详情子目录 ID、根目录长图 itemId、各类目 itemId 集合）；`data/locks/industry-layout.lock` 存在时禁止新采集写入。未知文件夹移动结果必须只读核对，不重复提交；历史 `migrate-eagle` 只能合并旧日期根目录，不能把行业结构展平。

## 质量闸门

```powershell
node --test tests/*.test.mjs
node scripts/capture.mjs --self-test
node scripts/check-environment.mjs
```

只有实际运行并通过验证的步骤才能报告为已完成。跨 PC2 部署也必须按 `docs/INSTALL-WINDOWS.md` 验证；不得以 PC1 历史成功代替新电脑验收。