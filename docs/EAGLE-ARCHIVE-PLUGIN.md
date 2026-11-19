# Eagle 归档闭环与手机详情页窗口插件

本说明与 `docs/PIPELINE-RULES.md` 配套。项目仍只支持已适配的天猫/淘宝商品页面；以下操作不替代网站登录、Eagle 许可证或素材来源核验。

## 1. 单商品采集的完整闭环

默认入口：`node scripts/ecom.mjs capture "<完整商品链接>"`。

1. 使用完整 URL 扫描；从网页取得主图及详情图的明确顺序。
2. Eagle MCP `item_add` **仅提交一次**；`item_get` 根据确切的素材 ID、名称、文件路径和尺寸回读。
3. 通过 `scripts/eagle-archive.mjs` 自动建立/复用 `天猫批量采集_YYYY-MM-DD/<商品ID>/主图|详情页`，用 `item_add_to_folders` 仅建立文件夹关联，不重复下载图片，不删除原分类。
4. 再次只读回查每个素材是否处于正确的 Eagle 子文件夹；`receipt.archive.status` 必须为 `complete` 才视为分类闭环完成。
5. 图片的 Eagle 入库状态、本地副本状态、归档状态、HTML 和 OCR 后处理独立记录。任何一步不完整不得伪装成成功。

归档命令仅查询和移动**文件夹关联**，不会调用 Eagle `item_add`：

- `node scripts/ecom.mjs archive <商品ID> --check`：只读检查，不创建目录。
- `node scripts/ecom.mjs archive <商品ID> [YYYY-MM-DD]`：补分类、读取 Eagle 当前真实素材并保存独立对账快照；原始 receipt 不改写。
- `node scripts/ecom.mjs stitch-eagle <商品ID> [宽度] [--check]`：直接从 Eagle 原图拼接，仅成品 JPG 回存 Eagle 商品根目录；默认按图片常见宽度，超长自动分段。
- `node scripts/ecom.mjs export <商品ID>`：只在需要 OCR 或独立源图交付时复制原图到本地，不重新采集。

**失败处理：** Eagle 返回素材 ID 不等于确认落库。PC1 Eagle 已实测「重复添加提示」在等待处理时不会产生可回读的实体文件；先检查 GUI 是否有该弹窗，仅对任务内已授权测试素材选择恰当处理，其他既有素材不可擅自覆盖。对 `item_add` 状态不确定的批次，先通过 `item_get` 查证，严禁自动重复提交。对 `folder_create`、`item_add_to_folders` 状态不确定的写入也先只读检查。GIF 等动态素材必须校验实际可读及帧信息，不把本地直连补图冒充 Eagle 完整。

## 2. 两种本地存储模式

在本机 `config/local.json` 中配置：

```json
{"storageMode":"eagle"}
```

- `copy`（默认）：维持传统的 Eagle 归档 + 本地 `main/`、`detail/` 副本 + HTML。
- `eagle`：Eagle 是唯一常规图片库。采集回执与分类索引仍保存在项目 `data/`，不再自动复制图片至 `output/`，也不生成依赖本地切片的离线 HTML。插件直接读取 Eagle `fileURL`。
- 只有 OCR、外部软件或交付独立图片才按需执行 `ecom export <商品ID>`。**拼接不用 export**：`ecom stitch-eagle <商品ID> [宽度] [--check]` 直接读取 Eagle 原图，自动按高度分段，生成 JPG 并回存 Eagle 商品根目录；旧文件不自动清理。

## 3. Agent 直接读取 Eagle 拼接

PC1 已用独立 Eagle QA 商品实测，PC2 已用完整 50 张真实商品详情图实测：不依赖复制整套切片，也不调用 Eagle 的手动拼接窗口。FFmpeg 路径来自本机配置，推荐使用可解码动画 WEBP 的 FFmpeg 9+；Eagle 自带 6.1 对部分动画 WEBP 解码失败，勿直接覆盖官方依赖二进制。

`ecom stitch-eagle <商品ID> --check` 先确认 Eagle 当前分类、连续编号、物理文件与 SHA-256；执行时保留 `data/stitch-eagle/` 下可追溯的成品与提交状态，向商品 ID 根目录导入长图并回读。若目标已经存在、发生同名或出现不确定提交状态，则停止自动重复写入。原始详情切片不更改；本地 `ecom stitch` 作为独立图片副本的兼容入口。

## 4. html3.html / Eagle 窗口插件

`html3.html` 是统一 UI 源码，保留普通文件夹选择、拖入、手机连续预览和缩放。运行在 Eagle 插件窗口时，额外显示「从 Eagle 加载」。

使用官方 `eagle.folder.getSelected()`、`eagle.folder.getById()`、`eagle.item.get()` 和 `item.fileURL`；按 `Tmall-<商品ID>-detail-001` / `Taobao-<商品ID>-detail-001` 排序，并提示缺图。读取文件不会复制、覆盖 Eagle 原始图片。

在 PC1 或 PC2 项目目录执行：

```powershell
node scripts/build-eagle-plugin.mjs
```

生成：

- `eagle-plugin/manifest.json`
- `eagle-plugin/index.html`
- `eagle-plugin/logo.png`
- `release/Eagle-Detail-Preview-0.1.1.eagleplugin`

**PC1 Eagle 4.0 原生实测**：通过 Eagle「插件 → 开发者选项 → 导入本地项目」选择 `eagle-plugin` 文件夹注册，插件会出现于「开发」分类。已验证 3/3 张详情图片读取、原生弹窗、100%→150% 缩放。**仅复制文件到插件目录，在运行中的 Eagle 不一定完成注册**；或者用 Eagle 的安装/打包功能安装 `.eagleplugin`。仅开发测试时可将插件文件夹置于当前 Windows 用户 `%APPDATA%\\Eagle\\Plugins\\ECOMPREVIEW26`，需根据 Eagle 当前版本重新加载/重启后才可能出现在插件菜单。

使用方式：在 Eagle 中选择某个商品的「详情页」文件夹，点击「Ecom 详情页手机预览」；或选中一张编号详情图打开插件。在普通 Chrome 中打开 `html3.html` 仍然可以选择单独的图片文件夹。

## 5. 验收标准

- 全部 Eagle 已验证素材的分类关联准确；名称、itemId、文件路径及实际文件存在。
- 初次采集以 `receipt.archive.status=complete` 表示当次分类成功；历史补图通过 `ecom archive <商品ID> --check` 查询 Eagle 当前实物，新的 itemId / 格式替换保存在独立快照，保留原始 receipt。缺图、重复名称和无实体文件都不得视为完整。
- 长图拼接的前置是 Eagle 当前分类图片序号连续、实物可读、哈希可核、FFmpeg 与 FFprobe 可用、根目录没有同名长图。超过 65,500px 分段；GIF/动画 WebP 只以静态首帧写入 JPG，原动图不变。目标导入状态不明确时不得自动重复提交。
- 插件：使用真实选中目录，检查所有图片顺序、GIF 播放、缺图提示、缩放及重新打开，避免把浏览器模拟测试冒充 Eagle 原生窗口验收。
- 两台电脑分别运行 `node --test tests/*.test.mjs`；插件构建运行 `node scripts/build-eagle-plugin.mjs`。PC2 可额外使用 `node tests/eagle-plugin-browser-smoke.mjs <详情页文件夹ID>` 做 Chrome 模拟测试，**该模拟不能替代 Eagle 原生窗口测试**。
- 发布到 GitHub 前：运行 `node scripts/audit-public.mjs` 与 `node scripts/package.mjs --tag <新标签>` 的公开包核验；不推送本机配置、素材与回执。Git commit 和 push 均须单独授权。
