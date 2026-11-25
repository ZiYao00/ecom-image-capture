# Changelog

The project uses Semantic Versioning for public tags. Version labels describe **publication readiness**, not guarantees that every Tmall page will be accessible.

## [Unreleased]

- V3.1 production-readiness candidate: shared bounded read-only Eagle retries with classified request failures, single-attempt mutations, SKU conflict/unknown checks, explicit batch `--engine v2|v3`, persisted cross-batch barriers, corrected nested time budgets, verified slot/postprocess recovery, and storage-mode-aware delivery checks. Default V2 and Node 20.19+ contract unchanged; V3 still requires Node 24+ and explicit opt-in.
- Added AA/BB snapshot-scoped source closeout (`--check`, `--prepare`, `--apply <snapshotId>`); preserve all original files and unrelated associations, stop on uncertain writes. Long-image rendering and proven prior submissions can be resumed without replaying unknown imports.
- PC2 current local baseline: 7 products / 342 logical positions / 7 long images previously verified; new V3 batch existing-item test verified 3/3 with zero additional Eagle items and unchanged receipts. 2026-11-24 BB fresh V3 queue E2E passed: 4 products / 161 logical positions (149 new imports, 12 exact-byte reuse) / 4 long images. One actual FFprobe timeout recovered through postprocess_only without replaying source image imports or changing the original receipt. Active batch locks prevented overlapping duplicate starts. Nonempty BB snapshot closeout passed: all 4 original IDs and hashes preserved, target associations verified, 0 remaining, 0 files deleted. PC2 acceptance across the current AA and BB closeout scope: 11 distinct products, 503 logical image positions and 11 long images; final Node 24 regression 203/203 with no skips and public-source audit 140/140. Candidate is ready for feature-branch review, not a stable release. Independent PC1, further uncertain-write scenarios and clean Windows release acceptance remain gates.

- Windows CI: V3 experimental SQLite test cases are explicitly skipped below Node 24, preserving V2 verification on Node 22 without removing experimental coverage on Node 24.

- Acceptance gate still open: a fresh PC2 product `680462386354` failed the **read-only** Tmall page scan (`incomplete_before_eagle`, access abnormal) on 2026-11-23. No Eagle image import was attempted; the affected historical scan remains unresolved. Subsequent PC2 fresh V3 multi-product capture and long-image E2E passed; the independent PC1/CI acceptance gates still apply before merging into `main`.

- PC2 Eagle 实体行业分层：原有 29 个商品文件夹整体通过 `folder_update(parentId)` 移入一级行业（成人用品 19、3C数码 8、服饰内衣 2），原商品/主图/详情目录 ID 与 itemId 关联全部保留；11 个已完整商品的 750px 长图迁移后复核仍 complete。
- 统一新旧商品目录查找；新采集依据商品标题在创建 Eagle 目录前确定行业，未知分类进入「待分类」；人工改类联动整个商品目录，禁止重复 ID。单商品迁移及回退均有持久化预提交快照，旧日期合并工具不能展平新行业层级。

- PC2 行业自动分类：已对 29 个商品登记分类（成人用品 19、3C 数码 8、服饰内衣 2）；独立分类字段保留旧淘宝 URL、手动锁定及现有采集状态。
- Eagle 原生智能文件夹 + 增量标签：11 个完整商品的长图代表项已验证；18 个长图尚未完整验收的商品只保存业务分类。采集/verify-live 完成时自动联动，分类异常不影响采集交付。
- 增加 ecom industry --check / --apply / --list / --set / --sync-eagle 查询及恢复入口；未重新导入、重命名或移动任何既有图片。

- V3.1 experimental, **off by default**: Node 24 built-in SQLite SHA-256 index, browser-representation CDN prefetch, persistent event journal, Eagle library-wide lock, V2 Web API physical readback, byte-identical source reuse and single-intent path import behind `v3Experimental`. Existing `capture` remains V2.
- PC2 V3 proof: initial 1,379/1,379 eligible Eagle images indexed; 23/23 original CDN image bytes matched for a historical product. Subsequent five-product real-Eagle E2E verified all 150 logical positions: 131 newly imported and 19 exact-byte reused; five 750px detail-long JPGs independently verified. Safe zero-Eagle-write recovery, certification-image scan filtering, CDN server-format evidence, and post-stitch index accounting validated. Default rollout and multi-host E2E remain separate gates.
- Legacy V2 Eagle batches now stop submitting later batches as soon as one is partial, preserving all unsubmitted logical image positions for safe recovery.

- Eagle Use Original support: per-product logical (category, order) → physically verified Eagle itemId mapping; shared original remains globally named and stored once.
- Native folder-description mapping for the Eagle detail preview window; map-aware archive verification and stitching; safe, no-reimport historical rescue CLI (`map-eagle`, `reconcile-reused`).
- PC2 proof: existing product 891544196832 detail-038 uses existing item MWKES3062V2DX, 43/43 logical slots mapped, original file unchanged. Chrome-mocked Eagle preview loaded 38/38 actual images. Actual new-product duplicate-popup E2E and native-installed Eagle plugin revalidation remain separate gates.


- V2 candidate (PC2 feature branch): unified Eagle archive root, existing-folder-ID migration and legacy receipt fallback.
- Journaled bounded Eagle batches, isolated local-image recovery with no blind retries, and automatic post-capture 750px long-image stitching once archive verification passes.
- PC2 historical 19-folder migration and recovered 1024881530158 now independently verified; the root cause of Eagle's duplicate-content ghost acknowledgements is not yet verified against Eagle internals.
- Added serial multi-URL batch queue (up to 40 URLs, journaled per item, skip known receipts), live Eagle/long-image verification with registry state refresh, optional bounded exact-duplicate recovery preserving GIF frames, and bounded Chrome navigation-context retry.
- PC2 batch observed JPG, GIF and PNG duplicates across products; recovered per-product assets verified, while a separately requested URL was blocked before local execution. New V3 batch queue has passed both idempotent existing-item checks and fresh multi-URL E2E on PC2. No public release claim.

- Public GitHub preparation: official Chrome DevTools MCP pinned in the project lockfile, isolated Chrome profile, Eagle official MCP compatibility contract, safe public source manifest.
- Windows GitHub Actions CI now smoke-tests the extracted release ZIP, including project-local dependency install, unit tests and setup dry-check.
- Public Windows end-to-end acceptance remains a separate release gate.

## [0.2.0-beta.8] - 2026-11-13

- Agent installation now recommends the tested direct `node scripts/ecom.mjs setup` entrypoint, bypassing nested PowerShell process-tree limitations.
- Windows PowerShell prerequisite checker remains available, while system package installation requires explicit opt-in.
- Added cross-machine guidance for restricted Agent hosts and preserved detailed installer logs under ignored runtime/.

## [0.2.0-beta.7] - 2026-11-13

- Use the npm CLI bundled beside Node.js so Agent installations work without npm.cmd on PATH.
- Installer waits only for its Node process, not for the intentionally persistent Chrome browser process, preventing false timeout on the first run.
- Verified supervised Windows PowerShell installation and JSON status output in restricted Agent environments.

## [0.2.0-beta.6] - 2026-11-13

- Windows PowerShell installer now captures the Node CLI through a supervised process, avoiding silent-success failures on restricted Agent hosts.
- Installer writes diagnostic logs only inside the ignored project runtime/installer-logs directory.
- Cross-machine process-lock tests preserve safety when Windows PID liveness is uncertain and do not require optional FFmpeg.
- Confirmed project-local Chrome and Eagle MCP readiness on isolated installations of PC1 and PC2.

## [0.2.0-beta.5] - 2026-11-13

- Added Agent-ready JSON CLI and Windows installer bootstrap for project-local setup and capture.
- Optional explicit winget provisioning of missing Node.js, Chrome, and Eagle desktop dependencies.
- Preserved Eagle MCP plugin enablement and Tmall user sign-in as explicit external GUI actions.
- Added no-auto-reimport behavior and CLI regression tests.

## [0.2.0-beta.4] - 2026-11-13

- Cross-machine Windows tests no longer require optional FFmpeg/FFprobe to be installed.
- Process-lock tests preserve conservative behavior when Windows cannot verify PID liveness.
- PC2 project-local Chrome MCP installation and browser connectivity verified; Eagle MCP service activation remains pending.

## [0.2.0-beta.3] - 2026-11-13

- Public-source audit now supports ZIP distributions without a Git directory.
- Independent project Chrome mode verified against a fresh local install and Eagle MCP.

## [0.2.0-beta.2] - 2026-11-13

- Public-source audit and Windows CI now share an explicit file whitelist with ZIP packaging.
- Fixed project Chrome startup port-conflict handling by checking both IPv4 and IPv6 loopback listeners.
- Added MIT LICENSE, GitHub guides and templates.

## [0.2.0-beta.1] - 2026-11-13

- Default offline `detail/HTML.html` generation and optional local OCR command.
- Eagle MCP eventual-consistency readback retries, safe recovery and explicit capped fallback (10 images maximum per product).
- Project-local configuration and output directory, first-run setup and portable ZIP builder.
- Existing PC1 shared-Chrome mode kept for compatibility.
- Tests cover scan classification, data/index locking, recovery, HTML and image composition.

> Historical product receipts are local runtime data; neither GitHub nor the public ZIP includes them.
