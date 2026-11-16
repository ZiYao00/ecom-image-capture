# Windows standalone installer entry. Does not depend on any neighboring projects.
[CmdletBinding()]
param(
    [switch]$InstallSystemDependencies,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$next = @()
$installed = @()

function Test-Exe([string[]]$paths) {
    foreach ($p in $paths) {
        if (-not [string]::IsNullOrEmpty($p) -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $true }
    }
    return $false
}
function Get-Missing {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $script:nodeExe = if ($env:ECOM_NODE_EXE -and (Test-Path -LiteralPath $env:ECOM_NODE_EXE -PathType Leaf)) {
        $env:ECOM_NODE_EXE
    } elseif ($nodeCommand) { $nodeCommand.Source } else { $null }
    $nodeOkay = [bool]$script:nodeExe
    if ($nodeOkay) {
        try {
            $raw = & $script:nodeExe --version
            if ($raw -and "$raw" -match '^v?([0-9]+\.[0-9]+\.[0-9]+)') {
                $nodeOkay = ([version]$Matches[1] -ge [version]'20.19.0')
            }
            # A valid node.exe with suppressed --version output is not treated as absent.
            # The JS CLI will verify the running Node version before installing dependencies.
        } catch { $nodeOkay = $false }
    }
    $systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { 'C:' }
    $programRoots = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
        (Join-Path $systemDrive 'Program Files'), (Join-Path $systemDrive 'Program Files (x86)'),
        $env:LOCALAPPDATA) | Where-Object { $_ } | Select-Object -Unique
    $chromeCandidates = @($programRoots | ForEach-Object {
        Join-Path $_ 'Google\Chrome\Application\chrome.exe'
    })
    $chrome = Test-Exe $chromeCandidates
    # Legacy shared mode does not require a second Chrome installation.
    $configPath = Join-Path $root 'config\local.json'
    if (Test-Path -LiteralPath $configPath) {
        try {
            $localConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($localConfig.chromeMode -eq 'shared') { $chrome = $true }
        } catch { }
    }
    $eagleCandidates = @($programRoots | ForEach-Object {
        Join-Path $_ 'Eagle\Eagle.exe'
    })
    if ($env:LOCALAPPDATA) {
        $eagleCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Eagle\Eagle.exe'
    }
    $eagle = Test-Exe $eagleCandidates
    if (-not $eagle) {
        $eagle = @(Get-Process -Name Eagle -ErrorAction SilentlyContinue).Count -gt 0
    }
    [pscustomobject]@{ node = $nodeOkay; chrome = $chrome; eagle = $eagle }
}
function Publish-Status([string]$status, [object]$checks, [string[]]$actions, [object[]]$changes) {
    [pscustomobject]@{
        tool = 'ecom-image-capture'
        phase = 'windows_prerequisites'
        status = $status
        checks = $checks
        installedByThisRun = $changes
        nextActions = $actions
        note = 'Eagle MCP plugin and Tmall sign-in may require GUI or user interaction.'
    } | ConvertTo-Json -Depth 6 -Compress
}
$checks = Get-Missing
if ($InstallSystemDependencies -and -not $CheckOnly) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget -and (-not $checks.node -or -not $checks.chrome -or -not $checks.eagle)) {
        Publish-Status 'needs_action' $checks @('Install Windows App Installer / winget first') $installed
        exit 10
    }
    $tasks = @()
    if (-not $checks.node) { $tasks += [pscustomobject]@{ id = 'OpenJS.NodeJS.LTS'; name = 'node' } }
    if (-not $checks.chrome) { $tasks += [pscustomobject]@{ id = 'Google.Chrome'; name = 'chrome' } }
    if (-not $checks.eagle) { $tasks += [pscustomobject]@{ id = 'ogdesign.Eagle'; name = 'eagle' } }
    foreach ($task in $tasks) {
        # Explicit opt-in only. An unsuccessful installation is never retried automatically.
        & winget install --id $task.id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -ne 0) {
            Publish-Status 'failed' $checks @("winget install $($task.id) failed; inspect its output. Do not blindly retry.") $installed
            exit 2
        }
        $installed += $task.id
    }
    $machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path','User')
    $env:Path = "$machinePath;$userPath;$env:Path"
    $checks = Get-Missing
}
if (-not $checks.node) { $next += 'Install Node.js >=20.19.0 (winget: OpenJS.NodeJS.LTS); reopen your terminal' }
if (-not $checks.chrome) { $next += 'Install Google Chrome or set chromeExecutablePath in config/local.json' }
if (-not $checks.eagle) { $next += 'Install/start Eagle App and enable its official MCP Server plugin' }
if ($next.Count -gt 0) {
    Publish-Status 'needs_action' $checks $next $installed
    exit 10
}
if ($CheckOnly) {
    Publish-Status 'prerequisites_found' $checks @('Run install.ps1 without -CheckOnly to initialize project tools') $installed
    exit 0
}
# Run the Node CLI through a supervised process with captured files.
# Some restricted Agent hosts suppress stdout from a nested PowerShell invocation.
$logRoot = Join-Path $root 'runtime\installer-logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$runId = [Guid]::NewGuid().ToString('N')
$stdOut = Join-Path $logRoot "setup-$runId.json"
$stdErr = Join-Path $logRoot "setup-$runId.stderr.txt"
$cliPath = Join-Path $root 'scripts\ecom.mjs'
$cliArg = '"' + $cliPath + '" setup'
try {
    $child = Start-Process -FilePath $script:nodeExe -ArgumentList $cliArg -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdOut -RedirectStandardError $stdErr
    # Wait for the Node CLI only; Start-Process -Wait also waits for its persistent Chrome descendants.
    if (-not $child.WaitForExit(240000)) {
        Publish-Status 'failed' $checks @('Project CLI has not finished. Inspect runtime/installer-logs before any retry.') $installed
        exit 2
    }
    $child.Refresh()
    $setupCode = $child.ExitCode
} catch {
    Publish-Status 'failed' $checks @('Unable to launch the project Node CLI through Start-Process. Inspect the runtime installer logs.') $installed
    exit 2
}
$setupText = if (Test-Path -LiteralPath $stdOut) { (Get-Content -LiteralPath $stdOut -Raw -Encoding UTF8).Trim() } else { '' }
if (-not $setupText) {
    Publish-Status 'failed' $checks @('Node CLI emitted no result. Run node scripts/ecom.mjs setup directly; inspect runtime/installer-logs.') $installed
    exit 2
}
try {
    $setupJson = $setupText | ConvertFrom-Json -ErrorAction Stop
    if (-not $setupJson.status -or $setupJson.tool -ne 'ecom-image-capture') {
        throw 'Invalid setup response'
    }
} catch {
    Publish-Status 'failed' $checks @('Unable to verify Node CLI setup output. Run node scripts/ecom.mjs setup directly and check its JSON result.') $installed
    exit 2
}
Write-Output $setupText
exit $setupCode
