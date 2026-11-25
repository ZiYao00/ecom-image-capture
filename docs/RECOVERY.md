# ecom-image-capture｜异常恢复 SOP（当前权威版本）

**原则：先检查既有回执及现场，再决定执行命令；绝不删除回执来重新入库。**

| 现场与证据 | 正确动作 | 严禁 |
|---|---|---|
| `incomplete_before_eagle`、`eagle=not_called`、`leftPageOpen=true` | 检查现有商品标签，必要时以用户完整 URL 在**同一标签**中导航，随后 `capture.mjs --resume-existing <ID>`（会复用保存的输出根目录） | 新建另一个采集任务并绕过旧回执 |
| 页面显示“访问异常提示” | 停止 Eagle 提交，确认专用 Chrome 登录与当前页面；必要时等待用户在专用浏览器完成正常访问，再复用标签 | 自动破解验证码或绕过风控 |
| `eagle=may_have_submitted` 或 `uncertain_no_retry` | Eagle 结果不明确。只读查已有素材、记录 itemId 和回执 | 重新提交整个 `item_add` |
| `eagle=partially_verified` | 先等待/只读重查；用 `recover-known.mjs <ID>` 按名字唯一匹配；本地已安全补图时可以先执行 `ecom recover-eagle <ID> --check` | 用数组位置关联素材 |
| Eagle 重查确认为少量缺失 | `recover-direct.mjs <ID>` 只读判定，再 `--apply`，最多累计 10 张；回存 Eagle 单独执行 `ecom recover-eagle <ID> --apply` | Eagle 离线时改脚本批量主采集；超过 10 张或不确定提交再次重试 |
| `phase=success`、HTML 未生成 | `html-preview.mjs --product <ID>`；人工模板需要显式 `--force` 才能覆盖 | 重新采集同商品 |
| OCR 出错或不存在 | 检查独立 OCR 环境并只运行 `ocr.mjs --product <ID>` | 将原始图片标记失败 |
| 异常退出或索引落后 | `lock-health-cli.mjs status` 和 `reconcile-captures.mjs --check`；仅在确认情况后使用现有 `--apply` | 强制删活动锁、回执、历史目录 |

## 三种状态不混淆

- **Eagle 完整**：商品预期图片位置（类别 + 顺序）均唯一映射到已验证 itemId、正确文件夹与可读取物理素材；复用原图可保留旧商品名称，同一 itemId 允许多位置引用。
- **本地交付完整**：输出目录所有预期图片可读；允许标注最多 10 张的独立直连补图。
- **后处理完整**：HTML、OCR、长图单独报告；其失败不影响已经交付的原图。

## 安全恢复规则

1. 同一商品不重复执行正式 `capture.mjs`；回执存在必须先只读诊断。
2. 对已有商品使用原 `data/captures.json.outputDir`，不要把路径自动变更到项目 `output/`。
3. Eagle 回读出现延迟时，执行器只重试只读 `item_get`，不得重试 `item_add`。
4. 当 Eagle 查重结果非唯一、工具离线、原始图片 URL 非允许的 HTTPS CDN、已有同编号文件或待补图片超过十张时，脚本直连补图必须拒绝执行。
5. 所有直接补图保留独立记录。不能因为 `localStatus=complete` 就把 `eagleStatus` 或 `phase` 伪造成完全成功。
6. 历史目录、人工 HTML、浏览器 Profile、Eagle 素材库、工作区外软件及 Git 记录均不能作为常规清理对象。
7. PC2 真实案例：Eagle 返回 itemId 或 GUI 显示并不足以证明实体落库；必须 `item_get` + `.info` 文件存在、尺寸/哈希核验。遇到回存日志 `submitting` 与空实体时，停止所有自动重试。已发现同一图片内容可能存在于**其它商品**目录，Eagle 全库去重/已有素材引用可能导致原商品缺图与错误分类；只比对当前商品内部素材不足以排除重复。不要将另一个商品的图片直接重命名、覆盖或强制重新导入，也不要在没有独立商品序号映射的情况下把旧商品命名的素材算作本商品完整。
8. 当前 Eagle 归档路径为 `电商平台批量采集/<一级行业>/<ID>/主图|详情页`；旧日期路径仅供历史定位。PC2 29 个商品已使用官方 `folder_update(parentId)` 整体迁移，商品目录及其主图/详情目录 ID 未变。原始图片不重采、不复制，长图仍在商品 ID 根目录。
9. V2 的跨商品完全重复文件（GIF、PNG、JPG 或静态 WebP）可在受控直连本地补图（每商品≤10 张）后，使用 `ecom recover-duplicates <ID> --check` 做 Eagle 全库 SHA-256 对照及旧 itemId 物理缺失检查；只有确认可恢复才显式执行 `--apply`。副本改变字节哈希但须保留 GIF 动画帧、时序和真实像素；任意未知提交结果都停止。不能以此断定 Eagle 内部去重算法已被完全定位。
10. 已核验原图和长图、但历史 `data/captures.json` 仍标记不完整时，使用 `ecom verify-live <ID> --check` 再 `--apply` 更新当前索引状态，保留原始失败回执。批量任务使用 `ecom batch <urls.txt> --check|--apply`；已有完整同 SKU 商品先独立复核；不完整商品不得重新采集，显式 V3 批次仅允许符合下文证据条件的受控恢复，绝不覆盖旧回执重采。

## Eagle「使用原图」的优先恢复路径

先确认商品已有 Eagle 分类、记录了原始图片 URL / 顺序，并查看是否有重复弹窗或关联到当前分类的其它商品命名素材。不要直接调用 `recover-direct` 或重新编码。

1. `node scripts/ecom.mjs reconcile-reused <ID> --check`：在原本不完整的商品上，只读核对缺图位置与目标目录已有原图的 SHA-256、独立补图哈希（若已有）、原 Eagle itemId，无法唯一确定就停止。
2. `node scripts/ecom.mjs reconcile-reused <ID> --apply`：仅保存已证实的商品级映射，绝不调用 `item_add`。若映射完成，调用 `node scripts/ecom.mjs map-eagle <ID> --apply` 将序号信息写入 Eagle 分类文件夹说明以供窗口插件读取。
3. `node scripts/ecom.mjs archive <ID> --check`：按映射核验全部逻辑位置；`stitch-eagle --check` 核验长图。若长图已存在但缺乏原生成标记，报告 `existing_eagle_targets_no_retry`，不得重复提交。
4. 检查 `verify-live --check` 与 `captures.json` 状态时需区别**已完整的逻辑映射**和**主图分类中的历史无关附加素材**；未受本任务授权，不清理其它用户原有 Eagle 分类。原有 `recover-duplicates` 仅在无法安全复用且获得适当授权后作为备用工具。

## V3.1 新状态与恢复边界（实验链路）

- 本机专用：`data/fingerprints/v3-eagle.sqlite` 为可重建只读索引的本地缓存，`data/v3-cache/<ID>/` 为原始字节缓存；`data/v3-jobs/<ID>.json` 和 `<ID>.events.jsonl` 是必须保留的提交意图日志。
- `planned/prefetched/matched` 表示尚无图片导入提交；`reuse_link_intent` 表示可能提交过分类关联；`import_intent/import_acknowledged` 表示可能提交过不可幂等的 Eagle 入库；`verified` 只表示实体文件和逻辑位置完全验证。意图不确定时进入 `needs_read_only_review`，**不得再次调用 item/add**。
- 本机 `data/v3-locks` 是 Eagle 库级互斥，正常释放后归档锁文件；若意外中断残留，先核实进程和每个意图日志，不能简单删锁重做。
- Eagle Web API 与 MCP 的读取不一致时，以**同一个有效 ID 的当前 Eagle Web API 返回值、资源库物理素材 SHA-256 和正确文件夹关联**为判据；MCP 查询为空只是诊断信号，不代表可重发。
- 若外部 Eagle 库数量变化、索引非完整、CDN 返回编码变化、缓存被篡改或 GIF 动画不符，停止影响的导入部分。重新建立本地只读索引后再重新评审，不能自动重复已提交的请求。
- 用户历史商品 `1005836374256` 的 V2 原始回执与失败证据保留；即使 P0 已找到被复用的原始 GIF，正式完成状态仍以 `reconcile-reused` 映射、`archive --check` 和详情长图实物检查为准，不可只凭指纹匹配宣布完整。
- V3 有独立 `ecom v3-resume --check|--apply <商品ID>`：只有原始回执存在、完整事件日志证明**从未调用 Eagle 导入或关联写入**、商品图片序号和 URL 一致、Eagle 当前索引数量与缓存匹配，才允许基于同一商品安全继续；已提交过任何 `import_intent` / `reuse_link_intent` 一律拒绝重试。原始失败回执不改写；收尾仍需 `verify-live --check`，完整后 `--apply` 更新登记。
- 新增 `ecom v3-resume-partial --check <ID> [原始完整URL]` 与对应 `--apply`：支持严格可证的 V2 部分提交（首次须完整原 URL）以及 V3 部分任务。先 `v3-index --build`，检查日志、回执、SKU、目录、缓存和当前库；所有旧提交位置必须先取得确定的物理文件、SHA-256 与目标目录关联。只有明确没有提交意图的剩余位置允许写入；未知旧提交不能重新调用，即使 API 通道改变也不能。`--check` 不写 Eagle。完成后单独 `verify-live <ID> --check` / `--apply` 更新当前登记；原始 receipt 不改写。
- V3 的部分恢复入口若全部原图位置在持久化事件中已验证，按原 ID/哈希/目录重建并核验商品映射，报告 `resumeStage: postprocess_only`，不重新预取或进入原图导入。copy 模式仅补齐缺少的本地副本和项目生成的 HTML，冲突文件和人工 HTML 不覆盖；eagle 模式无本地副本要求。`verify-live` 独立验收交付后才登记完成。
- 长图 `rendering.json` 证明仅处在渲染阶段时，可在新子目录重新渲染，旧文件保留；存在 `submission.json` 时，已提交部分必须由实际名称、ID（已知时）、尺寸和 SHA-256 证明；结果不明时不得重发，只允许确证从未提交的 prepared 部分继续。没有有效标记的历史冲突仍须人工对账。
- V3 批次遇到可恢复失败最多走一次 `v3-resume-partial` 的检查与应用，完成后独立 `verify-live`；子进程超时、仍在运行、无证据或跨批次未决任务时熔断。2026-11-24 BB 真实批次中 FFprobe 渲染超时发生在长图提交前，队列自动刷新索引并检查 postprocess_only 后安全补齐长图，38 个原图位置与原回执哈希均保持。外层调用返回活跃批次锁时，应按既有进程与日志回读，绝不因调用结果异常启动重复批次。来源收尾的 `data/source-closeout` 快照和事件日志须保留，关联写入失败以实际目标/来源关联和实体哈希只读核对，禁止直接重复提交。
- `ecom capture-v3` 仍处于实验开关关闭状态。PC2 五商品试验及 2026-11-24 AA 六商品真实收尾（301 个图片位置、6 张长图）通过，V2 部分提交续采与 V3 零写入恢复也已实测；BB 4 个新商品（161 个位置、4 张长图）通过新版 V3 两批真实采集，且实际 FFprobe 超时的仅后处理自动恢复及非空 BB 来源快照收尾已通过；不确定写入的逐位置恢复通过模拟回归，但跨主机、并发和真实丢失提交响应场景仍未全部验证；不因此开启默认 V3，也不清理真实原图或历史映射。

## 行业分类异常恢复

- 先执行 ecom industry --check [ID] 检查商品级分类，再用 --sync-eagle [ID] 恢复已验收商品的 Eagle 行业/子类标签；不创建智能文件夹。禁止将分类异常当作缺图重新采集。
- 人工更正：ecom industry --set <ID> <industryCode> <subcategoryCode>，写入人工锁定。只移除本项目的旧行业标签，保留全部其它 Eagle 标签和原始图片。
- incomplete 或没有已验收长图的商品返回 pending_long_image，分类可登记但不得发布代表图；未知商品名词为 needs_review，自动采集仍正常。
- Eagle 标签写入结果不明时，先核查 `data/industry-sync/<ID>.events.jsonl` 与当前 Eagle 标签；未确定前不重新执行不确定写入。旧行业 Smart Folder 已停用自动创建；历史视图清理或回退仅在明确授权、独立快照和官方操作验证下进行，不通过重复采集恢复视图。
- 分类前的商品登记快照保存于 runtime/industry-backups，恢复只针对受影响分类字段，保留期间其它采集信息修改。

## 商品行业文件夹迁移恢复

- 行业主目录现为 `电商平台批量采集/<一级行业>/<商品ID>/主图|详情页`。迁移时保存 `data/migrations/industry/<商品ID>-*.json`，含原父目录 ID、目标父目录 ID、商品目录与主图/详情目录 ID、根目录及子目录的原 itemId 集合。
- 如果 `folder_update` RPC 中断、不确定或存在 `move_intent` 但缺少 `move_verified`，先 `ecom industry-folders --check <ID>` 和 Eagle 当前 `folder_get`，再人工核对该迁移快照；**不要重新调用 --apply 或尝试第二次移动**。其他商品无需因此重采。
- 回退前先执行 `ecom industry-folders --rollback <ID>`（只读），确认当前父目录、原目录 ID、原 itemId 关联与迁移快照一致；只有另行显式执行 `--rollback <ID> --apply` 才会将商品文件夹移回原父目录，且保留已创建的行业目录，不做删除清理。回退后分类数据仍是原行业，可能暂时存在位置不一致，后续需统一补正。
- 人工重新分类 `ecom industry --set ID industry subcategory` 现会移动整个商品目录；写入失败时保留人工分类与待同步标记，不可误报全流程完成。行业/子类标签仅辅助筛选，旧行业 Smart Folder 不再创建；不需要重新生成长图或重复导入原图。

## 常用只读命令

```powershell
node scripts/check-environment.mjs
node scripts/captures.mjs list
node scripts/recover-known.mjs <商品ID>
node scripts/recover-direct.mjs <商品ID>
node scripts/lock-health-cli.mjs status
node scripts/reconcile-captures.mjs --check
```

除上述被代码保护的恢复入口外，`docs/HANDOFF-*` 与 `references/legacy/` 只作为历史诊断记录，不作为执行脚本来源。
