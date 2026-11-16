# Security Policy

This project runs Chrome DevTools MCP and Eagle MCP locally. Treat both services as having access to private browser sessions or personal asset libraries.

## Safe defaults

- Bind the Chrome remote-debugging endpoint to `127.0.0.1` only; never expose its port on the LAN or public Internet.
- Use a project-specific Chrome profile. Never commit or share `runtime/`, browser cookies, credentials, `config/local.json` or Eagle's asset library.
- Eagle official MCP plugin must be explicitly enabled by the user; its local URL is not a public API endpoint.
- No auto-login, CAPTCHA bypass or automatic retries of uncertain `item_add` operations.
- Direct image fallback is explicitly capped at 10 assets per product and only applies after Eagle verification and deduplication.
- Do not include real customer/shop data in public issue reports. Remove full URLs with personal tracking parameters and all authentication details.

## Reporting

Please do not publish credential exposure or local-service vulnerabilities in a public issue. Contact the repository maintainer privately through their GitHub profile until a dedicated security reporting channel is configured. Only non-sensitive bugs belong in Issues.

## Supported versions

Security fixes are intended for the latest public release; pre-release versions may change behavior during the beta phase.
