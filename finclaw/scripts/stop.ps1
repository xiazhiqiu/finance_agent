$ErrorActionPreference = "Stop"
$financeDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pidFile = Join-Path $financeDir ".runtime\processes.json"
$processIds = [System.Collections.Generic.HashSet[int]]::new()

if (Test-Path -LiteralPath $pidFile) {
  $processes = Get-Content -Raw -Encoding UTF8 -LiteralPath $pidFile | ConvertFrom-Json
  foreach ($entry in $processes) { [void]$processIds.Add([int]$entry.pid) }
}

$configPath = Join-Path $financeDir "config.json"
if (Test-Path -LiteralPath $configPath) {
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
  foreach ($port in @([int]$config.ports.backend, [int]$config.ports.gateway, [int]$config.ports.web)) {
    $pattern = "127\.0\.0\.1:$port\s+0\.0\.0\.0:0\s+LISTENING"
    foreach ($line in @(netstat -ano | Select-String $pattern)) {
      [void]$processIds.Add([int](($line.ToString().Trim() -split "\s+")[-1]))
    }
  }
}

if ($processIds.Count -eq 0) { Write-Host "No Finance Advisor processes found." }
foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $process.Id -Force
    Write-Host "Stopped PID $processId"
  }
}
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
