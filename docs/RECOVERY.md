# ecom-image-capture｜异常恢复 SOP（当前权威版本）

**原则：先检查既有回执及现场，再决定执行命令；绝不删除回执来重新入库。**

| 现场与证据 | 正确动作 | 严禁 |
|---|---|---|
| `incomplete_before_eagle`、`eagle=not_called`、`leftPageOpen=true` | 检查现有商品标签，必要时以用户完整 URL 在**同一标签**中导航，随后 `capture.mjs --resume-existing <ID>`（会复用保存的输出根目录） | 新建另一个采集任务并绕过旧回执 |
| 页面显示“访问异常提示” | 停止 Eagle 提交，确认专用 Chrome 登录与当前页面；必要时等待用户在专用浏览器完成正常访问，再复用标签 | 自动破解验证码或绕过风控 |
| `eagle=may_have_submitted` 或 `uncertain_no_retry` | Eagle 结果不明确。只读查已有素材、记录 itemId 和回执 | 重新提交整个 `item_add` |
| `eagle=partially_verified` | 先等待/只读重查；用 `recover-known.mjs <ID>` 按名字唯一匹配；确认全部可恢复才显式 `--apply` | 用数组位置关联素材 |
| Eagle 重查确认为少量缺失 | `recover-direct.mjs <ID>` 只读判定，再 `--apply`，最多累计 10 张 | Eagle 离线时改脚本批量主采集；超过 10 张 |
| `phase=success`、HTML 未生成 | `html-preview.mjs --product <ID>`；人工模板需要显式 `--force` 才能覆盖 | 重新采集同商品 |
| OCR 出错或不存在 | 检查独立 OCR 环境并只运行 `ocr.mjs --product <ID>` | 将原始图片标记失败 |
| 异常退出或索引落后 | `lock-health-cli.mjs status` 和 `reconcile-captures.mjs --check`；仅在确认情况后使用现有 `--apply` | 强制删活动锁、回执、历史目录 |

## 三种状态不混淆

- **Eagle 完整**：预期素材全部有正确唯一名称、itemId、真实文件路径与尺寸。
- **本地交付完整**：输出目录所有预期图片可读；允许标注最多 10 张的独立直连补图。
- **后处理完整**：HTML、OCR、长图单独报告；其失败不影响已经交付的原图。

## 安全恢复规则

1. 同一商品不重复执行正式 `capture.mjs`；回执存在必须先只读诊断。
2. 对已有商品使用原 `data/captures.json.outputDir`，不要把路径自动变更到项目 `output/`。
3. Eagle 回读出现延迟时，执行器只重试只读 `item_get`，不得重试 `item_add`。
4. 当 Eagle 查重结果非唯一、工具离线、原始图片 URL 非允许的 HTTPS CDN、已有同编号文件或待补图片超过十张时，脚本直连补图必须拒绝执行。
5. 所有直接补图保留独立记录。不能因为 `localStatus=complete` 就把 `eagleStatus` 或 `phase` 伪造成完全成功。
6. 历史目录、人工 HTML、浏览器 Profile、Eagle 素材库、工作区外软件及 Git 记录均不能作为常规清理对象。

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
