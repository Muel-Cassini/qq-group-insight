# 以「可被 CDP 控制」的方式启动 Microsoft Edge（MediaCrawler 采集用）
#
# 用法（在 PowerShell 中执行）：
#   .\tools\launch-edge-cdp.ps1                 # 用独立调试 profile 启动
#   .\tools\launch-edge-cdp.ps1 -Port 9222      # 指定端口（默认 9222）
#   .\tools\launch-edge-cdp.ps1 -Kill           # 关闭由本脚本启动的调试实例
#
# 说明：
# - 使用独立 user-data-dir（默认 %LOCALAPPDATA%\dsh-edge-cdp），因此不会与你日常的 Edge 冲突；
#   代价是首次需要在这个窗口里重新登录小红书 / 知乎 / B站（登录态随后会保留在该目录）。
# - 若想复用日常 Edge 的登录态，请改为在你日常 Edge 里打开 edge://inspect/#remote-debugging
#   并勾选 “Allow remote debugging for this browser instance”，然后不要运行本脚本。

param(
  [int]$Port = 9222,
  [string]$UserDataDir = "$env:LOCALAPPDATA\dsh-edge-cdp",
  [switch]$Kill
)

$ErrorActionPreference = 'Stop'

$edgeCandidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "未找到 msedge.exe，请确认已安装 Microsoft Edge" }

if ($Kill) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$UserDataDir*" }
  if (-not $procs) { Write-Host "没有由本脚本启动的调试实例（user-data-dir=$UserDataDir）"; exit 0 }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "已关闭 $($procs.Count) 个调试实例"
  exit 0
}

$already = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like "*--remote-debugging-port=$Port*" }
if ($already) {
  Write-Host "端口 $Port 上已有 Edge 调试实例在运行（PID $($already[0].ProcessId)）"
} else {
  New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
  $args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$UserDataDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    "--disable-features=TranslateUI"
  )
  Start-Process -FilePath $edge -ArgumentList $args | Out-Null
  Write-Host "已启动 Edge 调试实例（端口 $Port，profile $UserDataDir）"
}

# 等待并验证 CDP 端点
$ok = $false
foreach ($i in 1..15) {
  Start-Sleep -Milliseconds 800
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
    Write-Host "CDP 就绪：$($v.Browser)"
    Write-Host "WebSocket: $($v.webSocketDebuggerUrl)"
    $ok = $true
    break
  } catch { }
}
if (-not $ok) { Write-Warning "CDP 端口 $Port 仍不可访问；请手动确认 Edge 是否被安全软件拦截" }

Write-Host ""
Write-Host "下一步：在这个 Edge 窗口里登录小红书 / 知乎 / B站，然后运行采集："
Write-Host "  python .agents/skills/social-crawl/scripts/crawl.py --platform xhs --keywords `"关键词`" --out artifacts/social/<批次>"
