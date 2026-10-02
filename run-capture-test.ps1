param(
  [string]$AppPath = "$PSScriptRoot\out-capture-fixes\Stoat-win32-x64\stoat-desktop.exe",
  [string]$WebRoot = "$PSScriptRoot\..\for-web\packages\client",
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$AppPath = [IO.Path]::GetFullPath($AppPath)
$WebRoot = [IO.Path]::GetFullPath($WebRoot)
$dist = Join-Path $WebRoot 'dist'
if (!(Test-Path $AppPath)) { throw "Packaged test app missing: $AppPath" }
$index = Get-Content "$dist\index.html" -Raw
$asset = [regex]::Match($index, 'src="(/assets/index-[^"]+\.js)"').Groups[1].Value
if (!$asset) { throw 'Local web build has no entry asset' }
$js = Get-Content (Join-Path $dist $asset.TrimStart('/')) -Raw
if (!$js.Contains('[rtc] screen share sender')) { throw 'Local web build lacks sender diagnostics; rebuild for-web' }
$native = Join-Path (Split-Path $AppPath) 'resources\app.asar.unpacked\node_modules\win-capture\build\Release\win_capture.node'
$compiled = Join-Path $PSScriptRoot 'node_modules\win-capture\build\Release\win_capture.node'
if (!(Test-Path $native) -or (Get-FileHash $native).Hash -ne (Get-FileHash $compiled).Hash) { throw 'Packaged native addon differs from the locally compiled addon; repackage' }
$newestNative = Get-ChildItem "$PSScriptRoot\native\win-capture\src" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$newestShell = Get-ChildItem "$PSScriptRoot\src" -Filter '*.ts' -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$archive = Join-Path (Split-Path $AppPath) 'resources\app.asar'
if ((Get-Item $compiled).LastWriteTimeUtc -lt $newestNative.LastWriteTimeUtc -or (Get-Item $archive).LastWriteTimeUtc -lt $newestShell.LastWriteTimeUtc) { throw 'Test build is older than capture/shell source; rebuild and repackage' }
& node "$PSScriptRoot\native\win-capture\check-package.js" (Split-Path $AppPath)
if ($LASTEXITCODE) { throw 'Packaged capture integration check failed' }
if ($CheckOnly) {
  Write-Output 'CAPTURE LAUNCH PREFLIGHT PASS: packaged native matches; web sender diagnostics present'
  return
}
$running = Get-CimInstance Win32_Process -Filter "Name='stoat-desktop.exe'" -ErrorAction SilentlyContinue
if ($running) { throw "Close the running Stoat app first (PIDs: $($running.ProcessId -join ', ')); single-instance routing can otherwise load the wrong build" }
$url = 'http://127.0.0.1:4173'
try { $page = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 } catch { $page = $null }
if (!$page) {
  $vite = Join-Path $WebRoot 'node_modules\vite\bin\vite.js'
  if (!(Test-Path $vite)) { throw 'Vite missing; install web dependencies with pnpm' }
  Start-Process (Get-Command node).Source -ArgumentList @("`"$vite`"", 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort') -WorkingDirectory $WebRoot -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    try { $page = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2; break } catch {}
  }
}
if (!$page -or !$page.Content.Contains($asset)) { throw 'Port 4173 is not serving the expected local web build' }
$served = Invoke-WebRequest "$url$asset" -UseBasicParsing -TimeoutSec 10
if (!$served.Content.Contains('[rtc] screen share sender')) { throw 'Served web entry lacks sender diagnostics' }
Write-Output "Opening $AppPath with --force-server=$url"
Start-Process $AppPath -ArgumentList "--force-server=$url"
