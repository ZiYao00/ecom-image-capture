# Contributing

Thanks for considering improvements to ecom-image-capture.

## Scope

The project targets Windows and supported Tmall item pages. Changes must preserve the complete original URL, Eagle MCP as the primary importer, identity-based readback verification, safe resume semantics, a cumulative 10-image direct-recovery limit, and local offline HTML output.

## Development

```powershell
npm ci
node scripts/setup.mjs --check
node --test tests/*.test.mjs
node scripts/capture.mjs --self-test
```

Unit tests should not require an Eagle library, a signed-in browser or external credentials. Real-site tests must be opt-in and must not automatically import images in CI.

## Pull requests

- Explain which feature/bug is addressed and which product formats were covered.
- Add a targeted regression test for changed parsing/recovery behavior.
- Keep browser sessions, tokens, account-specific URLs, personal paths and generated images out of commits.
- Avoid changes to legacy records or migration tools without a clearly defined need.
