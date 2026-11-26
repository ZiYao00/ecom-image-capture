# 商品行业分类与 Agent 执行指南

> 当前规则版本：industry-2026-11-v2。分类定义与可执行规则唯一来源：`scripts/industry-core.mjs`。本文是分类决策与执行指南，不是独立的第二套规则。实际代码与只读检查结果优先；扩展时同步本文和测试。

## 1. 分类的目标与原则

分类服务于电商设计素材检索，而非照搬平台的店铺、营销或 SKU 类目。以实际销售商品的品类和用途为准，品牌、受众、功率、营销词、认证和使用场景不是行业。配件应归入明确服务的主产品行业和子类（例如电动牙刷替换刷头属于口腔护理）。不以共享 Eagle 图片 ID 推导商品行业。

目录固定为 `电商平台批量采集/<一级行业>/<商品ID>/主图|详情页`；二级分类仅写入商品登记与已验证的首张详情长图辅助标签。不要增加品牌、二级类目、日期或平台物理目录层级，不创建智能文件夹。

商品分类唯一业务事实为 `data/captures.json` 的 productId 对应 classification。分类与素材完整性分开报告；原始 receipt、完整商品 URL、原图和已验证长图不改写。人工锁定 manualLocked 优先于自动规则；未知/冲突转 needs_review，放在「待分类」，不得以其它行业掩盖不确定性。

## 2. 当前类目速查

| 一级行业（代码） | 可用子类（代码） | 典型范围 |
| --- | --- | --- |
| 成人用品 adult | 女用器具 female；男用器具 male；情趣道具 accessory；润滑护理 care；其它 other | 明确情趣用品 |
| 3C数码 electronics | 充电宝 powerbank；充电器 charger；数据线 cable；数码配件 accessory；其它 other | 消费数码及电源配件 |
| 服饰内衣 apparel | 胸贴 chestpad；打底裤 leggings；女士内衣 underwear；服装 clothing；其它 other | 服装、内衣及穿着配件 |
| 美妆护肤 beauty | 其它 other | 护肤、美妆类非仪器产品 |
| 个护电器 personalcare | 口腔护理 oral；美发电器 hair；剃须理容 grooming；美容仪器 beautydevice；其它 other | 个护设备及专用配件 |
| 家居日用 home | 枕类寝具 pillow；其它 other | 家居日用品、U 型枕等 |
| 食品生鲜 food | 其它 other | 食品、生鲜 |
| 宠物用品 pets | 其它 other | 宠物食品及用品 |
| 其它行业 other | 其它 other | 确认不属已有分类的商品 |

表中子类是允许使用的稳定编码，不等于每个子类都有自动识别规则。运行 `industry --check ID` 读取实际结果。禁止在数据或 Eagle 里临时自造编码。

## 3. 判定案例与关键词边界

| 商品描述 | 推荐类目 | 边界 |
| --- | --- | --- |
| 电动牙刷、牙刷替换刷头、冲牙器、水牙线 | personalcare/oral | 只有「刷头」不足以判断口腔护理；不得把清洁工具刷头归为电动牙刷 |
| 电吹风、吹风机、家用/负离子风筒、卷发棒、直发器 | personalcare/hair | 工业风筒、通风管、工业吹风机不能因「风筒」自动归类 |
| 电动剃须刀、理发器、电推剪、鼻毛修剪器 | personalcare/grooming | 单独「修剪器」可能是园艺工具 |
| 洁面仪、美容仪、脱毛仪 | personalcare/beautydevice | 美容设备与护肤品分开 |
| U 型枕、U 形枕、旅行枕、颈枕、记忆棉枕 | home/pillow | 全角/大小写兼容；仅枕套、枕罩或普通营销词不强行识别 |
| 充电宝、电源适配器/充电器、数据线 | electronics 下对应子类 | 仅 3C 认证、便携、小巧不能证明数码行业 |

同一标题命中多个行业时，保留 needs_review；同一行业出现得分与优先级相同的竞争子类时，保留 needs_review。不要通过增加宽泛词或任意提高权重来解决一个样例。若标题含多个商品名词、配套礼品或不确定语境，Agent 应结合用户已确认的商品身份及原始标题判断，仍不确定时报告待分类；不自动调用 LLM 或猜测平台类目。原词库正则才是精确自动匹配边界。

## 4. Agent 遇到待分类或用户更正时

1. 核对当前实际电脑、项目 AGENTS、分支/工作区、任务锁与商品登记。只读查看指定 ID 原始标题、分类（含人工锁定）、Eagle 实体目录和素材验收结果。不要为了分类再次打开商品页或采集。
2. 首选已有行业/子类。使用 `node scripts/ecom.mjs industry --check <ID>` 查看自动分类证据；人工锁定的商品在此保留人工结果。需要新行业或新子类时说明理由、建议稳定编码与适用边界，经用户授权后按第 5 节更新规则。
3. 对未锁定且新规则证据明确的单商品，按下方顺序执行。只处理获授权的 ID；若实际写入返回不明或失败，停止该商品后续写入，检查现场及迁移日志，不自动重发。
4. 用户明确授权人工更正具体商品时，使用 `--set`。它备份登记、锁定分类、移动原商品文件夹及同步长图标签。禁止因规则版本更新自动覆盖人工锁定。
5. 复核当前登记、目标行业目录、主图/详情页 ID 和商品根目录长图，独立验证原图映射、数量、长图物理文件与哈希、无残留任务锁及未创建智能文件夹。完成分类不意味着新素材采集成功；分别报告。

```powershell
# 未锁定商品：只读预检 -> 更新分类登记 -> 迁移单个目录 -> 同步标签
node scripts/ecom.mjs industry --check <ID>
node scripts/verify-live-product.mjs <ID> --check
node scripts/ecom.mjs industry --apply <ID>
node scripts/ecom.mjs industry-folders --check <ID>
node scripts/ecom.mjs industry-folders --apply <ID>
node scripts/ecom.mjs industry --sync-eagle <ID>
node scripts/verify-live-product.mjs <ID> --check

# 明确授权的人工更正（例如已人工锁定的枕类）
node scripts/ecom.mjs industry --set <ID> home pillow
node scripts/verify-live-product.mjs <ID> --check
```

`industry --apply` 仅改变业务登记，不直接迁移；`industry-folders --apply` 只移动商品目录，保留所有子目录和 itemId；`industry --sync-eagle` 仅同步专用标签。迁移快照和登记备份在本机 data/migrations/industry、runtime/industry-backups。需要回退时先使用 industry-folders --rollback ID 检查资格；实际回退需要明确授权。禁止直接修改 Eagle 库底层文件、删除目录/图片、创建智能文件夹、重复 item_add、使用 --all 无范围迁移。

## 5. 维护自动规则与类目

- 先找已有行业和子类。只有明确业务用途和长期检索价值才新增一级行业；一般新增二级类目优于一级行业泛滥。保留已用代码与显示名，除非另有兼容迁移方案。
- 经授权修改 industry-core.mjs 的 INDUSTRIES、EXACT、必要时 PRIORITY 和 INDUSTRY_RULE_VERSION。使用真实具体商品名词和限定上下文；加入明确正例、反例、跨行业冲突、同类冲突、人工锁定、实际标题回放。不得为某个品牌或单个商品 ID 硬编码分类。
- 更新此文、AGENTS/README 的入口及相关规则，新增可发布文档必须加入 .gitignore 白名单和 scripts/public-files.mjs。避免每个 Agent 在不同文档维护第二套分类表；若发现与源码不同，以代码为准并修正文档。
- 先运行 `node --test tests/industry-core.test.mjs tests/industry-eagle.test.mjs tests/eagle-industry-layout.test.mjs`，再运行 `node --test tests/*.test.mjs` 和 `node scripts/audit-public.mjs`。只读回放本机历史标题，报告新增识别/潜在改类；本次只调整获授权目标，不全量重算历史登记。
- Git 提交、推送、跨电脑同步分别依用户授权执行。本机分类登记、迁移快照、Eagle ID 不随源码复制；其他电脑使用同一规则但独立核验自己的素材库。
