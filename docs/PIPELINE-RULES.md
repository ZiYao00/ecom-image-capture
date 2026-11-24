# ecom-image-capture｜采集与交付规则（当前权威版本）

> 规则优先级：**代码中的约束与实际回执 > 本文 > README/AGENTS > 历史 HANDOFF**。历史案例只能用于诊断，不作为新执行入口。本规则适用于已适配的天猫商品，不承诺支持所有电商平台。

## 正式统一入口（用户与 Agent）

```powershell
node scripts/ecom.mjs setup                              # 首次安装、初始化并检测环境
node scripts/ecom.mjs doctor                             # 只读诊断；不向 Eagle 写入
node scripts/ecom.mjs capture "<完整天猫URL>"              # Eagle 入库 + 自动建分类；默认 copy 本地输出
node scripts/ecom.mjs capture "<完整天猫URL>" "D:\素材"     # 用户指定路径优先
```

也可使用 `ecom.cmd` 调用相同命令。`scripts/setup.mjs`、`scripts/check-environment.mjs`、`scripts/capture.mjs` 是统一 CLI 调用的底层兼容入口，普通用户无需分别执行。首次安装会在项目内安装已锁定的 Chrome MCP 依赖，但不会擅自安装系统软件或替用户登录。

### 强制不变量（执行器而非 Agent 负责）

1. **首次导航必须传递用户提供的完整原始 URL。** 保留 `ali_refid`、`ali_trackid`、`spm` 等参数；只允许将 ID/SKU 规范化后用于商品索引和 Eagle `website` 元数据，不允许用简化 URL 代替网页导航。
2. 商品图片由 **Eagle MCP 的有日志分批 `item_add`** 负责常规下载和归档，每批最多 8 张，每张原图只提交一次；随后 `item_get` 根据 **商品图片位置 + itemId + 物理文件** 验证；新入库素材仍核对名称，Eagle「使用原图」则核对原 itemId 的真实分类关联与可读取性，严禁按数组顺序匹配。提交结果不明时保留批次日志，禁止自动重传。
3. `item_get` 可能存在索引延迟：只读等待、有限重查，不可直接重发 `item_add`。**PC1 实测 Eagle「重复添加提示」会在用户选择前让相同原图内容的新导入处于待处理状态；MCP 返回成功 ID 不等于实体落库**。对缺少 `.info` 实体的条目保留不完整与证据，先检查 Eagle 是否有待处理重复弹窗，优先在授权范围内复用已有原图，核验真实 item ID、目录与 SHA-256；GUI 弹窗控件识别需单独实测，不依赖固定坐标或默认点击；严禁脚本盲目重复提交、批量覆盖既有素材。
4. **脚本直连只是例外补救**：必须已有 `partially_verified` 回执，先读 Eagle 查重，按产品任务累计最多 **10 张**，不得使 Eagle 未启动时变成主采集路径。使用独立命令显式执行；不得自动绕过 `item_add`。
5. 禁止缺失图片、未加载详情、访问异常时提前提交 Eagle；要保留任务拥有的商品标签。不要代替浏览器解决登录/验证码/风控限制。
6. 已有回执时禁止新建同一商品重复入库，按错误阶段选择恢复命令；同一商品独占锁，不同商品可并行。
7. 输出路径优先级：**命令显式路径 > `ECOM_OUTPUT_ROOT` > `config/local.json.outputRoot` > 项目 `output/`**。历史 `data/captures.json.outputDir` 固定不迁移、不可被新默认路径覆盖。
8. 存储模式：默认 `storageMode: copy` 在 Eagle 归档后复制 `main/01.jpg`、`detail/01.gif` 等本地文件；可通过本机配置设置 `storageMode: eagle`，只保留 Eagle 原图与回执，**不再重复复制图片**。历史输出不会自动删除或迁移。
9. `copy` 模式生成 `detail/HTML.html`，相对路径引用、离线打开、GIF 原生播放；`eagle` 模式改由 Eagle Window Plugin 的 `html3.html` 直接读取 `item.fileURL`，不生成本地图片目录或离线 HTML。拒绝覆盖人工定制 HTML，除非显式 `--force`。
10. OCR 是本地共享 RapidOCR 的可选后处理，分开生成 `商品ID-主图文案.txt` 与 `商品ID-详情页文案.txt`；未经人工核对的文本不视为准确原文。
11. V2 新商品在 Eagle 完整归档后**自动拼接 750px 详情长图**并验证回存；既有商品通过 `ecom finish <商品ID>` 继续。Eagle-only 首选 `ecom stitch-eagle <商品ID> [宽度] [--date YYYY-MM-DD] [--check]`：读取 Eagle 物理原图 → 哈希与顺序校验 → FFmpeg 拼接 → 仅成品 JPG 回存商品根目录 → 复验尺寸、哈希和分类。无需提前复制整套源图；原 `ecom stitch` 是本地副本兼容入口。拼接失败不改变原始采集状态。
12. 本地图片完整、Eagle 入库完整、Eagle 文件夹归档与后处理完成度分别报告。**本地补图不能伪装成 Eagle 已验证**。
13. 每次商品采集后调用 `eagle-archive.mjs` 创建/复用 `电商平台批量采集/<行业>/<商品ID>/主图` 和 `详情页`，通过 `item_add_to_folders` **只为已验证 itemId 建立分类关联**，随后再次只读 `item_get` 核对。失败保持 `receipt.archive.status=partial/needs_read_only_review`，不重发 `item_add`。
14. `archive <商品ID>` 以 Eagle 当前分类和真实物理素材核对，而不是把首次回执中旧 itemId 当作永久真相；`--check` 不写入，执行后保存独立当前快照到 `data/reconciliations/`，**原始 receipt 不改写**。旧日期目录可在迁移后按原回执回查；同 ID 多位置冲突必须停止；`export <商品ID>` 只供 OCR/独立源图交付等需要本地文件的场景。

## Eagle 原图复用与商品级顺序映射（V2）

- 每个商品在本机保存 `data/product-maps/<ID>.json`（version 1）：`main/detail + order + sourceUrl -> Eagle itemId + resolution(imported/reused) + sha256`。同一 itemId 可对应多个商品/序号；`item.name` 是 Eagle 全局名称，不代表当前商品的逻辑序号。不得因外部商品名称不同而自动判缺图。
- 新采集在执行 `item_add` 前创建目标主图/详情分类，并将类别文件夹传给 Eagle。若 Eagle「使用原图」，先以原始图片 URL 找到候选，再结合 **实际文件夹关联 / Eagle 明确返回原 itemId / 可读取物理原图及哈希** 唯一验证，不能只凭 URL 或文件名判断为复用成功。缺少证据或存在歧义则记 `needs_read_only_review`，不盲目补图或重试 `item_add`。
- 若 Eagle 返回**明确的原 itemId**但尚未建立目标分类关联，可在记录提交意图后调用一次官方 `item_add_to_folders`，回读验证关联和哈希。不因一个未落库的 ghost itemId 猜测旧素材身份，也不修改共享素材的名称。
- 新商品完整映射保存时，以原子写入/独立历史副本更新本机映射，并将精简 `order->itemId` 信息写入 Eagle 主图/详情页文件夹的 `description`（保留其它已有说明）。Eagle 预览插件优先读取该信息；旧商品未映射时仍使用文件名兼容模式。
- 允许同一图片 ID 出现在多个逻辑位置：归档验收、长图和预览均以逻辑位置顺序为准，物理文件数可少于图片位置数。不得把多个位置折叠为一张长图切片。
- 历史商品先 `ecom reconcile-reused <ID> --check`，仅能以真实当前分类关联与已核实内容等证据恢复，再 `--apply` 保存映射；已完整商品可 `ecom map-eagle <ID> --check|--apply` 建立及镜像映射。不需要重采，也不修改历史 receipt。原格式重新编码仅保留为明确授权的特殊补救方法，**不是自动默认路径**。
- 这些映射绑定各电脑自己的 Eagle 素材库。PC2 的 `data/`、文件夹描述和 itemId **不通过 Git 同步到 PC1**，PC1 需单独核验和生成映射。

## V3.1 可切换实验链路（PC2 真机验收通过，跨机与异常场景仍需回归，不改变 V2 默认）

- 默认 `ecom capture` 继续使用 V2；V3 仅在本机 `config/local.json` 显式设定 `v3Experimental: true` 后，才允许使用 `ecom capture-v3 "<完整商品 URL>"`。不自动打开此开关。
- V3 指纹索引：`ecom v3-index --check [抽样数]` 只读；`ecom v3-index --build` 扫描 Eagle 当前素材并写入**本机** `data/fingerprints/v3-eagle.sqlite`。需 Node.js 24+；V2 仍保留原来的 Node 20.19+ 约束。不同电脑、Eagle 库、ID 不跨设备复制索引。
- V3 预取诊断：`ecom v3-prefetch --check <已采商品ID>` 以浏览器一致性请求头读取 CDN 图片字节并与本机哈希索引比对，**不写入 Eagle**；`--cache` 只保存本项目 `data/v3-cache` 供调试，不导入 Eagle。CDN 返回格式与 URL 所标注编码不符时停下，不能直接认定为新素材。
- 正式 V3 任务先完整读取所有图片原始字节，再在 Eagle 本库锁下逐张执行：哈希精确匹配 → 当前 Web API 元数据 + 真实文件 SHA 校验 → 已有 ID 增加文件夹归属；未命中则将**同一份缓存原图**通过 Eagle Web API V2 `item/add(path)` 单次导入。不要修改旧原图的名称、元数据或文件内容。
- V3 `data/v3-jobs` 独立日志在任何官方写入之前持久化提交意图。遇到超时、接口不一致或不明结果即停止；不因为更换 API/MCP 通道而重发。整单成功以逻辑图片位置、文件夹、SHA-256 与后处理的独立验证为准。缓存暂不自动清理。
- 正式采集的 Web API V2 只读来源为当前本机 Eagle 41595；MCP 41596 继续承担文件夹与关联写入，V3 的读回可以使用 V2 元数据加独立物理文件校验，避免仅因 MCP 搜索延迟判缺图。每个正式商品或恢复任务前刷新索引；入库前比对全库图片 ID、物理文件大小、修改时间和数量，后续每次写入前检查库数量，精确命中项独立复核 SHA-256；同数量替换也会阻断预检。资源库发生外部变化时不冒险导入。
- 已通过 PC2 五商品真机试验：150 个逻辑位置完整、19 个位置完全复用 Eagle 原图，五张 750px 长图独立验证。仅当 V3 日志可证明零 Eagle 写入时允许使用 `ecom v3-resume --check|--apply <ID>`；原始回执不可重写，未知提交禁止重复调用。`ecom v3-resume-partial --check|--apply <ID> [原始完整URL]` 可恢复有提交历史的任务：V2 必须有可核对的提交前缀与显式未提交尾部；V3 必须有一致的独立事件日志。所有已提交位置先按真实 item ID、目标目录和 SHA-256 独立验证，只有明确未提交位置可新增写入。首次 V2 恢复提供原始完整 URL；只读预检通过后才执行。PC2 AA 实测 6/6 商品、301/301 位置、6/6 长图，其中 3 个 V2 历史任务保护 32 个既有位置、补齐 126 个未提交位置。
- 指纹索引的库存数量统一使用 `/api/v2/item/get` 所报告的可见素材 `total`，不要混用语义不同的 `countAll`；每次 Eagle 长图上传成功后将经 SHA 校验的成品纳入同一索引。外部认证资料图片要与真实商家详情图区分；CDN 实际编码与 URL 扩展名不同时，只有多次有界预取均返回相同原始字节且 MIME 有效才允许使用并记录格式差异，禁止隐式转码。
- V2 的 Eagle 分批导入发现任一批次不确定后立即停止后续批次，余下图片位置标为 `not_submitted_due_to_prior_uncertain_batch`，保留旧回执及其序号，不自动重试。未确认 V3 E2E 之前不可把 V3 改成默认生产采集流程。

## 商品级行业分类独立阶段

- 商品唯一分类来源为 data/captures.json.products[商品ID].classification，包含行业/子类编码、规则版本、证据、来源和人工锁定。原始 receipt 与历史淘宝 URL 不改写。分类不等于采集完整性。
- 商品标题按确切产品名词分类，AV、3C、mini 等泛词不作为行业依据；冲突或未知则 needs_review。人工锁定分类高于自动规则；本版无需 LLM API。
- ecom industry --check 只读预览；--apply 只修改业务分类；--list 查询；--set 手工改类并锁定；--sync-eagle 联动。原有 capture 与 verify-live --apply 只在完整商品验收后尝试自动联动，联动失败不影响采集状态。
- Eagle 通过带命名空间的 采集行业｜... / 采集子类｜... 标签与原生 Smart Folder 展示。只对独立验证过的商品首张 750px 长图设置标签；不导入或移动原图，不修改用户其它标签和文件夹。子类 Smart Folder 采用双标签筛选。
- Smart Folder 必须带本项目描述标识 ecom-image-capture:industry-v1:；同名非本项目目录不覆盖。Eagle 写入前记录 data/industry-sync 事件，未知结果停止并只读复核，禁止盲目重复创建。
- 未完成长图商品只登记行业，分类待同步状态不影响继续补图、去重和长图流程；PC1/PC2 各自维护 Eagle itemId 和智能文件夹，不跨机器复制元数据。

## Eagle 实体行业层级（当前主归档结构）

- **行业分类的主结果是整个商品 Eagle 文件夹的父目录**：`电商平台批量采集/<一级行业>/<商品ID>/主图|详情页`。一级行业由商品登记 `classification.industryCode` 唯一决定；二级子类仅为商品元数据和辅助筛选，不增加物理目录层级。未知行业进入 `待分类`。
- PC2 的 29 个原商品文件夹已按照成人用品 19、3C数码 8、服饰内衣 2 整体迁移；使用 Eagle 官方 `folder_update(parentId)`，不调用 `item_add`。商品、主图、详情目录 ID、图片关联及长图 ID 全部保留；原始 receipt、商品级映射、Windows 下 Eagle 库实体文件与旧本地交付路径均不修改。
- `scripts/eagle-folder-layout.mjs` 为唯一旧/新层级解析器；归档、补图、长图、V2/V3 路径均复用它。若同一商品 ID 出现在两个位置、行业目录名未知或行业 ID 冲突，必须停止并人工核验，禁止自动再创建同名商品目录。
- `ecom industry-folders --check [ID]` 只读；`--apply <ID>` 单商品迁移；`--apply --all` 将未归位商品逐个移动；`--rollback ID` 为只读回退资格检查，只有单独显式 `--rollback ID --apply` 才执行回退。任何真实移动都先在 `data/migrations/industry` 保存原父目录、商品/主图/详情文件夹 ID、商品根目录长图与源图片 itemId 集合，并在 `move_intent` 前持久化。RPC 结果不确定后只读复核，绝不直接重发。
- 迁移期间使用 `data/locks/industry-layout.lock`（独立保存归档历史）与 Eagle 资源库写入锁；已有正在处理的商品锁阻止迁移。旧版 `migrate-eagle` 仅合并日期根目录，已兼容行业嵌套，不能将商品展平回旧目录。
- `ecom industry --apply` 仍只更新分类元数据；`industry --set ID industryCode subcategoryCode` 会先保存人工锁定，再迁移已有商品目录，最后同步可用的智能文件夹标签。若移动不明，分类登记保留为待同步，不重复调用 Eagle。
- Eagle 原生智能文件夹和仅标记已验收长图的标签保留为**辅助筛选入口**，不是商品实体归档的替代品。未来恢复/手工同步行业目录必须使用 `industry-folders` 命令。
- 新商品在页图读取完成后，按照人工锁定/规则识别结果选择行业并直接创建目标商品文件夹，不能先创建旧根级目录再移动。真实新商品再次完成采集的全链路验收仍属于发布回归，不能由目录模拟测试替代。

## 批量采集与当前状态对账

- `node scripts/ecom.mjs batch "链接清单.txt" --check`：UTF-8 每行完整 URL 或 JSON 字符串数组，最多 40 项；验证重复商品 ID 与已有回执，**只读**。
- `node scripts/ecom.mjs batch "链接清单.txt" --apply`：逐单调用正式采集入口，每次提交意图写入独立 `data/batches/` 日志；共享服务故障、不明写入结果、验收失败或未知退出时立即熔断，后续商品记录 `not_started_due_to_batch_halt`；仅明确属于单商品扫描不完整且回执证明零 Eagle 写入的异常允许继续。**绝不重试已提交 Eagle 的商品，也不自动重采不完整回执**。
- 新商品页面导航后 Chrome 执行上下文临时失效时，仅在原商品标签页进行有限次数 `evaluate_script` 重查；不重新打开商品、不重复提交 Eagle。
- `node scripts/ecom.mjs recover-duplicates <ID> --check|--apply`：**独立显式操作**，仅对 Eagle 部分验证且已有合规本地补图、数量不超过 10 的商品；核验 Eagle 全库完全相同的 SHA-256、旧提交 itemId 物理缺失、GIF 帧数/时序和像素后才可生成不同文件哈希的副本并单张回存。若提交结果不明确，保留独立日志停止，不自动重试。仅支持可证明无损处理的格式。
- `node scripts/ecom.mjs verify-live <ID> --check|--apply`：重新验证 Eagle 原始素材与长图实体、尺寸和 SHA-256。只有完整才更新本地 `captures.json` 的最新完成状态；**历史 receipt 不改写**。

## 产物结构

```text
<输出根目录>/商品ID/
  main/01.jpg ...
  detail/01.jpg ...
  detail/HTML.html
  商品ID-主图文案.txt              # 可选
  商品ID-详情页文案.txt            # 可选
```

## 后处理、检查和恢复（均为现有脚本）

新分类与插件的完整 SOP 见 [EAGLE-ARCHIVE-PLUGIN.md](EAGLE-ARCHIVE-PLUGIN.md)。

```powershell
node scripts/html-preview.mjs --product <商品ID>      # 离线 HTML 独立重建
node scripts/ocr.mjs --product <商品ID>               # 可选 OCR
node scripts/recover-known.mjs <商品ID>               # Eagle 只读查重
node scripts/recover-direct.mjs <商品ID>              # 补图资格只读检查
node scripts/recover-direct.mjs --apply <商品ID>      # 经 Eagle 查重后显式本地补图，上限 10
node scripts/ecom.mjs recover-eagle <商品ID> --check   # 本地补图准备回存 Eagle 的只读检查
node scripts/ecom.mjs recover-eagle <商品ID> --apply   # 明确的单张回存及物理校验，不确定状态不重试
node scripts/ecom.mjs migrate-eagle --check           # 只读迁移规划
node scripts/ecom.mjs finish <商品ID>                   # Eagle 全部详情齐全后自动拼接 750px 长图
node scripts/lock-health-cli.mjs status
node scripts/reconcile-captures.mjs --check
node --test tests/*.test.mjs
```

异常处理以 [RECOVERY.md](RECOVERY.md) 为准；Windows 新机安装以 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) 为准。正式规则不继承 `docs/HANDOFF-*` 中已废止的命令。
