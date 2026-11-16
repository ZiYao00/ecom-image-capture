# Changelog

The project uses Semantic Versioning for public tags. Version labels describe **publication readiness**, not guarantees that every Tmall page will be accessible.

## [Unreleased]

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
