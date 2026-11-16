# Public GitHub release checklist

## Target repository (already exists)

- **Repository:** https://github.com/ZiYao00/ecom-image-capture
- **Description:** `Windows CLI for Tmall product image capture using Chrome DevTools MCP and Eagle MCP, with offline HTML preview and optional OCR.`
- **Visibility:** Public; as checked on 2026-11-16 the remote repository was empty and its default branch was `main`.
- **Do not create a second repository.** Do not initialize another README, .gitignore or LICENSE on GitHub; they already exist in this local workspace.
- GitHub will identify JavaScript as the main language after the first push.

## Local source review before first commit

The development workspace contains personal historical files. **Never stage the entire unfiltered workspace without inspecting**. The local .gitignore excludes data, profiles, outputs, historical docs, legacy scripts and private tests. Before staging, inspect the paths the public repository will include. Use the public ZIP manifest as the source of truth.

Minimal commands after the user authorizes the first commit:

```powershell
git status --short
git add .gitignore LICENSE README.md README.en.md AGENTS.md CHANGELOG.md SECURITY.md CONTRIBUTING.md package.json package-lock.json requirements-ocr.txt config docs scripts tests .github
git status --short
git diff --cached --name-only
# Review staged files before commit/push. Never upload runtime/ or data/.
```

The repository currently has no initial commit. Commit and push are separate actions requiring explicit authorization.

## Release gate

1. Source/public file audit and secrets scan PASS, including the staged Git file list.
2. Windows Node.js CI PASS on supported versions.
3. Local portable ZIP extraction and tests PASS.
4. A *separate* Windows installation: `npm ci`, project Chrome startup, Eagle official plugin setup, a new product's Eagle import plus local file and HTML checks.
5. Choose the release status conservatively: `v0.2.0-beta.8` only after the above acceptance. Pre-release checkbox should be enabled.

## Local Git alignment and remote setup

- Confirm the current `origin` points to `https://github.com/ZiYao00/ecom-image-capture.git` and the local branch is `main` (the remote's default). These are local-only configuration steps, not a commit or push.
- The repository was empty on 2026-11-16. Do **not** create it again or introduce unrelated files.
- After separately authorized local commit **and** push, verify GitHub `main`, then check the Windows CI result before marking a release.
- For a verified beta release, use **Releases → Draft a new release**, tag `v0.2.0-beta.8`, mark **Pre-release**, and attach the source ZIP plus its SHA-256.

This file is a checklist, not authorization to commit, push or publish.
