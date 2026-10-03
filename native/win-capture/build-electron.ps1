param([string]$Module = 'win-capture')
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ($Module -notin @('win-capture', 'win-app-audio')) { throw 'Unsupported native module' }
$src = Join-Path $repo "native\$Module"
$dst = Join-Path $repo "node_modules\$Module"
if (!(Test-Path $dst)) { throw 'Install dependencies with pnpm first' }
$electron = Get-Content (Join-Path $repo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json
$names = @('npm_config_runtime', 'npm_config_target', 'npm_config_disturl')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location $repo
try {
  robocopy $src $dst /E /XD build /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Source synchronization failed: $LASTEXITCODE" }
  $env:npm_config_runtime = 'electron'
  $env:npm_config_target = $electron.version
  $env:npm_config_disturl = 'https://electronjs.org/headers'
  pnpm exec node-gyp rebuild --directory $dst
  if ($LASTEXITCODE) { throw "Native build failed: $LASTEXITCODE" }
  $binary = Get-ChildItem "$dst\build\Release\*.node" | Select-Object -First 1
  $newest = Get-ChildItem "$src\src" -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (!$binary -or $binary.LastWriteTimeUtc -lt $newest.LastWriteTimeUtc) { throw 'Missing or stale native binary; repackage only after a successful rebuild' }
  Write-Output "$Module built for Electron $($electron.version): $($binary.FullName)"
} finally {
  Pop-Location
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
}
