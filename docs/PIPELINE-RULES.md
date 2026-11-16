# ecom-image-capture｜采集与交付规则（当前权威版本）

> 规则优先级：**代码中的约束与实际回执 > 本文 > README/AGENTS > 历史 HANDOFF**。历史案例只能用于诊断，不作为新执行入口。本规则适用于已适配的天猫商品，不承诺支持所有电商平台。

## 正式统一入口（用户与 Agent）

```powershell
node scripts/ecom.mjs setup                              # 首次安装、初始化并检测环境
node scripts/ecom.mjs doctor                             # 只读诊断；不向 Eagle 写入
node scripts/ecom.mjs capture "<完整天猫URL>"              # 默认保存到 output/商品ID
node scripts/ecom.mjs capture "<完整天猫URL>" "D:\素材"     # 用户指定路径优先
```

也可使用 `ecom.cmd` 调用相同命令。`scripts/setup.mjs`、`scripts/check-environment.mjs`、`scripts/capture.mjs` 是统一 CLI 调用的底层兼容入口，普通用户无需分别执行。首次安装会在项目内安装已锁定的 Chrome MCP 依赖，但不会擅自安装系统软件或替用户登录。

### 强制不变量（执行器而非 Agent 负责）

1. **首次导航必须传递用户提供的完整原始 URL。** 保留 `ali_refid`、`ali_trackid`、`spm` 等参数；只允许将 ID/SKU 规范化后用于商品索引和 Eagle `website` 元数据，不允许用简化 URL 代替网页导航。
2. 商品图片由 **Eagle MCP 的一次 `item_add`** 负责常规下载和归档。随后 `item_get` 根据 **名称 + itemId** 验证，严禁按数组顺序匹配。
3. `item_get` 可能存在索引延迟：只读等待、有限重查，不可直接重发 `item_add`。回读仍缺失时保留不完整状态与证据。
4. **脚本直连只是例外补救**：必须已有 `partially_verified` 回执，先读 Eagle 查重，按产品任务累计最多 **10 张**，不得使 Eagle 未启动时变成主采集路径。使用独立命令显式执行；不得自动绕过 `item_add`。
5. 禁止缺失图片、未加载详情、访问异常时提前提交 Eagle；要保留任务拥有的商品标签。不要代替浏览器解决登录/验证码/风控限制。
6. 已有回执时禁止新建同一商品重复入库，按错误阶段选择恢复命令；同一商品独占锁，不同商品可并行。
7. 输出路径优先级：**命令显式路径 > `ECOM_OUTPUT_ROOT` > `config/local.json.outputRoot` > 项目 `output/`**。历史 `data/captures.json.outputDir` 固定不迁移、不可被新默认路径覆盖。
8. 下载/入库后本地复制分别保存 `main/01.jpg`、`detail/01.gif` 等，保留原图格式，不擅自裁切、转换、合并。
9. **HTML 默认生成在 `detail/HTML.html`**，相对路径引用、离线打开、GIF 原生播放；拒绝覆盖人工定制 HTML，除非显式 `--force`。
10. OCR 是本地共享 RapidOCR 的可选后处理，分开生成 `商品ID-主图文案.txt` 与 `商品ID-详情页文案.txt`；未经人工核对的文本不视为准确原文。
11. 长图拼接仅在用户明确要求时运行 `scripts/stitch-detail.mjs`；失败不能导致原始图片采集倒退。
12. 本地图片完整、Eagle 入库完整与后处理完成度分别报告。**本地补图不能伪装成 Eagle 已验证**。

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

```powershell
node scripts/html-preview.mjs --product <商品ID>      # 离线 HTML 独立重建
node scripts/ocr.mjs --product <商品ID>               # 可选 OCR
node scripts/recover-known.mjs <商品ID>               # Eagle 只读查重
node scripts/recover-direct.mjs <商品ID>              # 补图资格只读检查
node scripts/recover-direct.mjs --apply <商品ID>      # 经鹰眼查重后显式补图，上限 10
node scripts/lock-health-cli.mjs status
node scripts/reconcile-captures.mjs --check
node --test tests/*.test.mjs
```

异常处理以 [RECOVERY.md](RECOVERY.md) 为准；Windows 新机安装以 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) 为准。正式规则不继承 `docs/HANDOFF-*` 中已废止的命令。
