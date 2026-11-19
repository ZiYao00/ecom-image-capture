# GitHub 发行与正式版验收说明

## 当前源码基线

- 仓库：`https://github.com/ZiYao00/ecom-image-capture`，分支 `main`。
- 2026-11-19 已推送 Eagle 自动分类、直读拼接和 Eagle 预览插件 v0.1.1，提交 `e33611e`；此后以 GitHub 实际 HEAD 为准。
- **GitHub main 有源码不等于已经发行正式 Release**。是否发布版本号/附件，必须另行通过当前版本的独立发行验收。
- 源码 `package.json` 版本仍为 `0.2.0-beta.8`。在决定正式发布版本号前不得擅自标称 `v1.0.0`。
- 不新建重复 GitHub 仓库，不把 PC1 配置、Eagle 素材库、历史截图、登录目录加入公开提交。

## 源码与产物目录约定

| 路径 | 角色 | 公开源码 ZIP |
| --- | --- | --- |
| `scripts/`、`tests/`、`docs/`、`eagle-plugin/` | 开发源码、测试、SOP、Eagle 插件源码 | 纳入白名单 |
| `config/local.example.json` | 可复制配置模板 | 纳入 |
| `config/local.json` | 每台电脑自己的路径、FFmpeg、Chrome 与 Eagle 配置 | 不纳入 |
| `runtime/`、`node_modules/` | Chrome Profile、运行时和可重装依赖 | 不纳入 |
| `data/`、`output/` | 采集索引、真实素材、回执、QA 与需要时的导出 | 不纳入 |
| `release/` | 本机发行包及独立验收副本 | 不纳入源码 ZIP、Git 提交 |

路径解析以项目根目录、Eagle MCP 提供的图片路径和本机配置为准；不得在公开源码中硬编码个人盘符。发行包在独立可写目录解压，不能要求用户安装到 `G:\GitHub` 或 `C:\AI`。

## 发行验收（必须逐项记录）

1. **源码状态**：Git 干净、无未预期修改；版本号、README 与 CHANGELOG 一致，Release 标签与源码 commit 对应。
2. **公开白名单**：`node scripts/audit-public.mjs` PASS；公开包不含配置、密钥、登录 Profile、商品回执、用户文件。
3. **功能测试**：`node --test tests/*.test.mjs`、`node scripts/capture.mjs --self-test` PASS；所有公共脚本 `node --check` PASS。
4. **可独立构建的 Eagle 插件**：无需预存 `release/Eagle-Detail-Preview-*.eagleplugin`；从清洁源码运行 `node scripts/build-eagle-plugin.mjs` 后，确认文件格式、清单和版本与源码一致。
5. **真正的 ZIP**：`node scripts/package.mjs --tag <版本标记>`，独立 ZIP 工具验证 CRC、文件清单和内容；**不得将 TAR 改名为 .zip**。
6. **独立 Windows 解压**：在与仓库目录不同的干净路径解压 ZIP，`npm ci --ignore-scripts --no-audit --no-fund`、全量测试、parser 自测、`audit-public` 和 `setup --check` PASS。
7. **跨设备**：PC2 或其他 Windows 电脑依据本机配置跑 `ecom doctor`，用真实新商品测试“浏览器扫描 → Eagle 实体回读 → 主图/详情分类 → 当前状态核对”；动态 WebP 和重复图案必须有明确恢复策略。
8. **原生 GUI**：Eagle 插件在至少一台真实 Eagle 4.x 设备中使用“选详情文件夹”和“选单张详情图”两种入口完成实际加载、缩放与动图检查。浏览器 mock 不能代替原生插件窗口验收。
9. **GitHub Actions**：实际检查最新提交对应的 Windows Node 22 / 24 作业结论；仅本机 PASS 不等于 CI PASS。
10. **发布操作**：确认上述状态后，另行授权/决定 Git commit、push、Release 标签、正式版或 pre-release，以及附件 ZIP、插件包和 SHA-256。

**未达到必要门槛时，应标注 RC/预发行，不得称为正式稳定版。**
