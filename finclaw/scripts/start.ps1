param(
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$financeDir = Split-Path -Parent $scriptDir
if (-not $ConfigPath) { $ConfigPath = Join-Path $financeDir "config.json" }

# Some launchers provide both Path and PATH. Windows Start-Process treats them
# as the same dictionary key and fails, so normalize only this process copy.
$processEnvironment = [Environment]::GetEnvironmentVariables()
$processPath = if ($processEnvironment.Contains("Path")) { [string]$processEnvironment["Path"] } else { [string]$processEnvironment["PATH"] }
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $processPath, "Process")

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    return $result.AsyncWaitHandle.WaitOne(250) -and $client.Connected
  } finally {
    $client.Dispose()
  }
}

function Wait-Port([int]$Port, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Port) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Missing config file: $ConfigPath. Copy config.example.json and configure the ports."
}
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json

$ports = @([int]$config.ports.backend, [int]$config.ports.gateway, [int]$config.ports.web)
foreach ($port in $ports) {
  if (Test-Port $port) { throw "Port $port is already in use. Run stop.ps1 or change config.json." }
}

$runtimeDir = Join-Path $financeDir ".runtime"
$logsDir = Join-Path $runtimeDir "logs"
$dataDir = Join-Path $runtimeDir "data"
New-Item -ItemType Directory -Force -Path $runtimeDir, $logsDir, $dataDir | Out-Null

# 生成前端 .env.local
$webEnv = @(
  "VITE_FINANCE_API_URL=http://127.0.0.1:$($config.ports.backend)"
  "VITE_GATEWAY_URL=http://127.0.0.1:$($config.ports.gateway)"
  "VITE_GATEWAY_TOKEN=$($config.gateway.authToken)"
  "VITE_AGENT_ID=$($config.agent.id)"
  "VITE_MANAGER_ID=$($config.agent.managerId)"
) -join [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $financeDir "web\.env.local"), $webEnv, [System.Text.UTF8Encoding]::new($false))

# 安装 Web 依赖
if (-not (Test-Path (Join-Path $financeDir "web\node_modules\.bin\vite.cmd"))) {
  Write-Host "First run: installing Web dependencies..." -ForegroundColor Cyan
  & corepack pnpm@10.23.0 --dir (Join-Path $financeDir "web") install
  if ($LASTEXITCODE -ne 0) { throw "Web dependency installation failed." }
}

# 安装 pi-gateway 依赖
$piGatewayDir = Join-Path $financeDir "pi-gateway"
if (-not (Test-Path (Join-Path $piGatewayDir "node_modules"))) {
  Write-Host "First run: installing pi-gateway dependencies..." -ForegroundColor Cyan
  & npm --prefix $piGatewayDir install
  if ($LASTEXITCODE -ne 0) { throw "pi-gateway dependency installation failed." }
}

# 启动 Backend
$env:FINANCE_BACKEND_PORT = [string]$config.ports.backend
$env:FINANCE_RUNTIME_DIR = $dataDir
$env:FINANCE_INTERNAL_TOKEN = $config.gateway.authToken
$backend = Start-Process -FilePath (Get-Command node).Source -ArgumentList @((Join-Path $financeDir "backend\src\server.mjs")) -WorkingDirectory $financeDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir "backend.log") -RedirectStandardError (Join-Path $logsDir "backend.error.log") -PassThru

# 启动 pi-gateway
$piAgentDir = Join-Path $financeDir ".pi"
$env:PI_CODING_AGENT_DIR = $piAgentDir
$env:FINANCE_API_URL = "http://127.0.0.1:$($config.ports.backend)"
$env:FINANCE_INTERNAL_TOKEN = $config.gateway.authToken
$env:PI_GATEWAY_PORT = [string]$config.ports.gateway
$gateway = Start-Process -FilePath (Get-Command npx.cmd).Source -ArgumentList @("tsx", (Join-Path $piGatewayDir "src\server.ts")) -WorkingDirectory $piGatewayDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir "gateway.log") -RedirectStandardError (Join-Path $logsDir "gateway.error.log") -PassThru

# 启动 Web
$web = Start-Process -FilePath (Get-Command corepack.cmd).Source -ArgumentList @("pnpm@10.23.0", "--dir", (Join-Path $financeDir "web"), "dev", "--host", "127.0.0.1", "--port", [string]$config.ports.web) -WorkingDirectory $financeDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir "web.log") -RedirectStandardError (Join-Path $logsDir "web.error.log") -PassThru

$processes = @(
  [ordered]@{ name = "backend"; pid = $backend.Id },
  [ordered]@{ name = "gateway"; pid = $gateway.Id },
  [ordered]@{ name = "web"; pid = $web.Id }
)
[System.IO.File]::WriteAllText((Join-Path $runtimeDir "processes.json"), ($processes | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

try {
  if (-not (Wait-Port ([int]$config.ports.backend))) { throw "Finance backend failed to start" }
  if (-not (Wait-Port ([int]$config.ports.gateway) 60)) { throw "pi-gateway failed to start" }
  if (-not (Wait-Port ([int]$config.ports.web))) { throw "Web app failed to start" }
} catch {
  foreach ($process in $processes) { Stop-Process -Id $process.pid -Force -ErrorAction SilentlyContinue }
  throw "$($_.Exception.Message). Check logs in $logsDir."
}

Write-Host "Finance Advisor started" -ForegroundColor Green
Write-Host "Web:        http://127.0.0.1:$($config.ports.web)"
Write-Host "Backend:    http://127.0.0.1:$($config.ports.backend)/health"
Write-Host "pi-gateway: http://127.0.0.1:$($config.ports.gateway)/health"
Write-Host "Logs:       $logsDir"

# 启动完毕后自动打开系统默认浏览器跳转至前端界面
$webUrl = "http://127.0.0.1:$($config.ports.web)"
try {
  Start-Process $webUrl
  Write-Host "Opened default browser at $webUrl" -ForegroundColor Cyan
} catch {
  Write-Host "Failed to open browser automatically. Please visit $webUrl manually." -ForegroundColor Yellow
}
