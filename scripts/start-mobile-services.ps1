param(
  [ValidateSet("dev", "start")]
  [string]$Mode = "dev",
  [string]$Token = "",
  [string]$RelayUrl = "",
  [switch]$KeepFeishuGateway
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

if (-not $Token) {
  $Token = if ($env:TFCLAW_TOKEN) { $env:TFCLAW_TOKEN } else { "demo-token" }
}
if (-not $RelayUrl) {
  $RelayUrl = if ($env:TFCLAW_RELAY_URL) { $env:TFCLAW_RELAY_URL } else { "ws://127.0.0.1:8787" }
}

$env:TFCLAW_TOKEN = $Token
$env:TFCLAW_RELAY_URL = $RelayUrl

function Stop-FeishuGatewayProcessTree {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
  $roots = $all | Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -match "@tfclaw/feishu-gateway" -or
      $_.CommandLine -match "apps[\\\\/]feishu-gateway"
    )
  }

  if (-not $roots -or $roots.Count -eq 0) {
    Write-Host "[mobile-services] feishu gateway is not running."
    return
  }

  $ids = New-Object "System.Collections.Generic.HashSet[int]"
  $queue = New-Object System.Collections.Queue

  foreach ($root in $roots) {
    $id = [int]$root.ProcessId
    if ($ids.Add($id)) {
      $queue.Enqueue($id)
    }
  }

  while ($queue.Count -gt 0) {
    $loopProcId = [int]$queue.Dequeue()
    $children = $all | Where-Object { [int]$_.ParentProcessId -eq $loopProcId }
    foreach ($child in $children) {
      $childId = [int]$child.ProcessId
      if ($ids.Add($childId)) {
        $queue.Enqueue($childId)
      }
    }
  }

  $targets = $all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Sort-Object ProcessId -Descending
  Write-Host "[mobile-services] stopping feishu gateway process tree ($($targets.Count) processes)..."
  foreach ($proc in $targets) {
    try {
      Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop
    } catch {
      # Ignore raced exits.
    }
  }
}

if (-not $KeepFeishuGateway) {
  Stop-FeishuGatewayProcessTree
}

Write-Host "[mobile-services] mode=$Mode"
Write-Host "[mobile-services] relay=$RelayUrl"
Write-Host "[mobile-services] token=$Token"

if ($Mode -eq "dev") {
  Write-Host "[mobile-services] building protocol package..."
  npm run build --workspace @tfclaw/protocol
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  Write-Host "[mobile-services] starting server(dev) + terminal-agent(dev)..."
  npx concurrently -n relay,agent -c cyan,green `
    "npm run dev --workspace @tfclaw/server" `
    "npm run dev --workspace @tfclaw/terminal-agent"
  exit $LASTEXITCODE
}

Write-Host "[mobile-services] building protocol/server/terminal-agent..."
npm run build --workspace @tfclaw/protocol
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build --workspace @tfclaw/server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build --workspace @tfclaw/terminal-agent
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[mobile-services] starting server + terminal-agent..."
npx concurrently -n relay,agent -c cyan,green `
  "node apps/server/dist/index.js" `
  "node apps/terminal-agent/dist/index.js"
exit $LASTEXITCODE
