# ecom-image-capture

A Windows-first CLI for capturing Tmall product main/detail images with **Chrome DevTools MCP** and the **official Eagle MCP Server plugin**. It verifies original Eagle assets, supports optional local copies and offline HTML in `copy` mode, and stitches a verified 750px detail-long JPEG after a complete archive. OCR is optional.

## Requirements

- Windows with Node.js 20.19+.
- Google Chrome (desktop application).
- Eagle 4.0 Build 12+ with its official **MCP Server** plugin enabled.
- No CodexPro, external Chrome Agent, WorkBuddy or separate AI-Runtime project is required.

## Install (one entry point)

Download the repository or a release ZIP. With Node.js already installed, the reliable Agent/user entrypoint is:

```powershell
node scripts/ecom.mjs setup
```

You can also run `.\ecom.cmd setup`. Use `install.ps1 -CheckOnly` to detect missing Windows prerequisites; only run the opt-in `-InstallSystemDependencies` mode after approving changes to system software.

For an Agent **explicitly authorized** to install missing system applications, use `-InstallSystemDependencies`. This invokes winget for missing Node.js, Chrome or Eagle only; installation may require Windows approval. The installer sets up project-local Chrome MCP, local configuration, a dedicated Chrome window and a read-only Eagle MCP check. It does not bypass login or install Eagle's plugin without authorization.

The same entry point works for users and Agents:

```powershell
.\ecom.cmd doctor
.\ecom.cmd capture "<complete original Tmall URL>"
.\ecom.cmd list
```

Log into Tmall using the newly opened, project-specific Chrome window. Install and enable **MCP Server** in Eagle's plugin manager, open your Eagle library, then run:

```powershell
.\ecom.cmd doctor
.\ecom.cmd capture "<your full original Tmall product URL>"
```

In default `copy` mode, a successful capture produces `output/<productId>/main/`, `output/<productId>/detail/` and `output/<productId>/detail/HTML.html`. In optional `storageMode: eagle` mode, Eagle retains the originals and its window plugin previews them directly; no redundant local image copies are created.

## Eagle industry folders and verified long images

The canonical Eagle layout is **`电商平台批量采集 / <industry> / <productId> / 主图 | 详情页`**. Industry is identified from the actual product title and stored per product in `data/captures.json`. Existing product folders are moved by changing their parent folder ID: item IDs, main/detail folder IDs and long-image associations are retained. Unknown or ambiguous product categories go under `待分类`. Native Eagle smart folders and tags remain optional secondary views.

```powershell
node scripts/ecom.mjs industry --check
node scripts/ecom.mjs industry --list electronics
node scripts/ecom.mjs industry-folders --check
node scripts/ecom.mjs industry --set <productId> electronics powerbank
```

Folder migration is an explicitly controlled operation (`industry-folders --apply <productId>`); it does not re-import files. PC2 has verified 29 product-folder moves and 11 complete products' long JPEGs. **This does not migrate another machine's Eagle library:** PC1 must reconcile its own archive and product registry before any local folder changes. See [pipeline rules](docs/PIPELINE-RULES.md) and [recovery](docs/RECOVERY.md).

The default `capture` command remains the V2 pipeline. V3.1 source-hash reuse is **experimental, disabled by default**, and requires Node.js 24+ plus an explicit per-machine configuration flag. Do not turn it on simply because its code is present in Git.

## Optional OCR

```powershell
node scripts/setup-ocr.mjs --install
node scripts/ocr.mjs --product <productId>
```

The optional OCR runtime is created under the project's ignored `runtime/` folder.

## Reliability and privacy

Eagle MCP is the normal image importer. For a partially verified Eagle batch, direct image recovery must be explicitly requested and is limited to **10 images total per product**, after a read-only deduplication check. Use the original complete URL for browser navigation; preserve local image formats/GIFs.

Browser profiles, credentials, capture records, runtime images and local configuration are excluded from the release ZIP and Git.

**Documentation:** [中文使用说明](README.md) · [MCP setup](docs/MCP-DEPENDENCIES.md) · [Windows setup](docs/INSTALL-WINDOWS.md) · [Recovery](docs/RECOVERY.md).

**Release status:** public beta candidate. A fresh-machine live Chrome → Eagle → HTML test is required before declaring the downloadable release stable.
