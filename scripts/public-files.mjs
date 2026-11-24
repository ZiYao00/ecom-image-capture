// One public-source allowlist for GitHub audit and ZIP release.
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

export const publicStatic = [
  '.gitignore','README.md','README.en.md','LICENSE','AGENTS.md',
  'ecom.cmd','install.ps1',
  'CHANGELOG.md','CONTRIBUTING.md','SECURITY.md',
  '.github/workflows/ci.yml','.github/ISSUE_TEMPLATE/bug_report.md',
  'package.json','package-lock.json','requirements-ocr.txt',
  'html3.html','eagle-plugin/manifest.json','eagle-plugin/index.html','eagle-plugin/logo.png',
  'config/local.example.json','config/README.md',
  'docs/PIPELINE-RULES.md','docs/RECOVERY.md','docs/INSTALL-WINDOWS.md',
  'docs/MCP-DEPENDENCIES.md','docs/GITHUB-RELEASE.md','docs/GIT-COLLABORATION.md',
  'docs/EAGLE-ARCHIVE-PLUGIN.md','docs/SHARED-RUNTIME.md'
];
export const publicScripts = [
 'browser.mjs','capture.mjs','capture-policy.mjs','capture-store.mjs','captures.mjs',
 'check-environment.mjs','chrome-connection.mjs','diagnose-open.mjs',
 'eagle-readback.mjs','eagle-reconcile.mjs','html-preview.mjs',
 'lock-health-cli.mjs','lock-health.mjs','ocr.mjs','ocr-worker.py','setup-ocr.mjs',
 'package.mjs','probe-mcp.mjs','receipt-sync.mjs','reconcile-captures.mjs',
 'recover-direct.mjs','recover-known.mjs','recovery-core.mjs','setup.mjs',
 'stitch-core.mjs','stitch-detail.mjs','public-files.mjs','audit-public.mjs',
 'browser-port.mjs','ecom.mjs','archive-product.mjs',
  'eagle-archive.mjs','storage-mode.mjs','build-eagle-plugin.mjs',
  'eagle-current.mjs','stitch-eagle-core.mjs','stitch-eagle.mjs',
   'eagle-migration-core.mjs','migrate-eagle-folders.mjs',
   'recover-eagle-local.mjs','eagle-batch.mjs',
    'batch-core.mjs','batch-capture.mjs','verify-live-product.mjs',
    'eagle-duplicate-core.mjs','recover-duplicates.mjs','chrome-navigation.mjs',
     'eagle-product-map.mjs','eagle-source-index.mjs','eagle-reuse-resolution.mjs','eagle-map-mirror.mjs','map-eagle-product.mjs','reconcile-reused.mjs',
      'v3-fingerprint.mjs','v3-index.mjs','v3-prefetch.mjs','v3-verify-prefetch.mjs',
      'v3-job-state.mjs','v3-eagle-import.mjs','v3-web-readback.mjs','v3-resume-no-write.mjs',
      'v3-recovery-core.mjs','v3-resume-partial.mjs',
       'industry-core.mjs','industry-eagle.mjs','industry-cli.mjs',
        'eagle-folder-layout.mjs','eagle-industry-move.mjs','industry-folder-cli.mjs'
];
export function publicFiles(root){
 const scripts=publicScripts.map(x=>'scripts/'+x);
 const tests=readdirSync(join(root,'tests'))
   .filter(x=>x.endsWith('.test.mjs')||x==='capture-store-worker.mjs')
   .map(x=>'tests/'+x);
 return [...new Set([...publicStatic,...scripts,...tests])].sort();
}
