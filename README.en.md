# ecom-image-capture

A Windows-first CLI for capturing Tmall product main/detail images using **Chrome DevTools MCP** and the **official Eagle MCP Server plugin**. It verifies Eagle imports, copies source assets to local folders and generates a self-contained offline `detail/HTML.html` viewer. OCR is optional.

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

A successful capture produces `output/<productId>/main/`, `output/<productId>/detail/` and `output/<productId>/detail/HTML.html`.

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
