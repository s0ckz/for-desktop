$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'WGC probe requires Windows' }
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskProbe = Join-Path $PSScriptRoot 'wgc-probe'
$taskElectron = Get-Content -LiteralPath (Join-Path $taskRepo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json
$taskNames = @('npm_config_runtime', 'npm_config_target', 'npm_config_disturl')
$taskPrevious = @{}
foreach ($taskName in $taskNames) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName) }
Push-Location $taskRepo
try {
    $env:npm_config_runtime = 'electron'
    $env:npm_config_target = $taskElectron.version
    $env:npm_config_disturl = 'https://electronjs.org/headers'
    pnpm exec node-gyp rebuild --directory $taskProbe --loglevel=warn
    if ($LASTEXITCODE -ne 0) { throw 'Private WGC probe build failed' }
} finally {
    Pop-Location
    foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName]) }
}
