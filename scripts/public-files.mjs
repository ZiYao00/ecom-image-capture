// One public-source allowlist for GitHub audit and ZIP release.
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

export const publicStatic = [
  '.gitignore','README.md','README.en.md','LICENSE','AGENTS.md',
  'ecom.cmd','install.ps1',
  'CHANGELOG.md','CONTRIBUTING.md','SECURITY.md',
  '.github/workflows/ci.yml','.github/ISSUE_TEMPLATE/bug_report.md',
  'package.json','package-lock.json','requirements-ocr.txt',
  'config/local.example.json','config/README.md',
  'docs/PIPELINE-RULES.md','docs/RECOVERY.md','docs/INSTALL-WINDOWS.md',
  'docs/MCP-DEPENDENCIES.md','docs/GITHUB-RELEASE.md'
];
export const publicScripts = [
 'browser.mjs','capture.mjs','capture-policy.mjs','capture-store.mjs','captures.mjs',
 'check-environment.mjs','chrome-connection.mjs','diagnose-open.mjs',
 'eagle-readback.mjs','eagle-reconcile.mjs','html-preview.mjs',
 'lock-health-cli.mjs','lock-health.mjs','ocr.mjs','ocr-worker.py','setup-ocr.mjs',
 'package.mjs','probe-mcp.mjs','receipt-sync.mjs','reconcile-captures.mjs',
 'recover-direct.mjs','recover-known.mjs','recovery-core.mjs','setup.mjs',
 'stitch-core.mjs','stitch-detail.mjs','public-files.mjs','audit-public.mjs',
 'browser-port.mjs','ecom.mjs'
];
export function publicFiles(root){
 const scripts=publicScripts.map(x=>'scripts/'+x);
 const tests=readdirSync(join(root,'tests'))
   .filter(x=>x.endsWith('.test.mjs')||x==='capture-store-worker.mjs')
   .map(x=>'tests/'+x);
 return [...new Set([...publicStatic,...scripts,...tests])].sort();
}
