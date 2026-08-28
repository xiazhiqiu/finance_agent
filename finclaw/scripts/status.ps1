$financeDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $financeDir "config.json") | ConvertFrom-Json
foreach ($item in @(
  @{ Name = "Backend"; Port = [int]$config.ports.backend },
  @{ Name = "Gateway"; Port = [int]$config.ports.gateway },
  @{ Name = "Web"; Port = [int]$config.ports.web }
)) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect("127.0.0.1", $item.Port, $null, $null)
    $online = $result.AsyncWaitHandle.WaitOne(300) -and $client.Connected
    Write-Host ("{0,-8} {1,-5} 127.0.0.1:{2}" -f $item.Name, $(if ($online) { "UP" } else { "DOWN" }), $item.Port) -ForegroundColor $(if ($online) { "Green" } else { "Red" })
  } finally { $client.Dispose() }
}
