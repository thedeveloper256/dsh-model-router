# B1 spike setup: create the throwaway `router-spike` profile from the shipped
# headless template, install this checkout's build into it, and apply the
# spike patch. Makes no model/API calls. Safe to re-run.
#
# v0.8.0+ declares engines.dsh for 0.2.1+ and installs as is. v0.7.x is
# refused on 0.2.x (peer ranges ^0.1.0-rc.8, REVIEW-AND-PLAN F8); for that,
# pass -AcceptRisk to grant the exact-version exemption for THIS throwaway
# profile only:
#   powershell -ExecutionPolicy Bypass -File spike\b1\setup.ps1 -AcceptRisk
param([switch]$AcceptRisk)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\router-spike'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$dshVersion = (& $dsh --version).Trim()
$pluginVersion = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version

Write-Host "1/5 Building the plugin in $repo"
Push-Location $repo; try { npm run build | Out-Null } finally { Pop-Location }

if (-not (Test-Path $profileDir)) {
  Write-Host "2/5 Creating profile router-spike from the headless template"
  & $dsh router-spike --from-default-profile headless --dump-config | Out-Null
} else {
  Write-Host "2/5 Profile router-spike already exists"
}
if (-not (Test-Path "$patchFile.orig")) { Copy-Item $patchFile "$patchFile.orig" }

if ($AcceptRisk) {
  Write-Host "3/5 Granting the exact-version exemption for dsh-model-router@$pluginVersion on dsh $dshVersion (router-spike only)"
  & $dsh plugin --profile router-spike allow-version "dsh-model-router@$pluginVersion" --dsh-version $dshVersion --accept-risk
} else {
  Write-Host "3/5 Skipping the version exemption (no -AcceptRisk); the install below will be rejected on dsh 0.2.x"
}

Write-Host "4/5 Installing the plugin from the local checkout"
# pnpm keeps a stale `file:` copy when the version is unchanged; drop it first
# so the profile always runs this checkout's current build.
& $dsh plugin --profile router-spike remove dsh-model-router 2>$null | Out-Null
& $dsh plugin --profile router-spike add "file:$repo"
if ($LASTEXITCODE -ne 0) { throw "Plugin install failed; re-run with -AcceptRisk on dsh 0.2.x." }

Write-Host "5/5 Writing the spike patch layer (template patch kept as cordis.patch.yml.orig)"
$orig = Get-Content "$patchFile.orig" -Raw
# An empty layer is written as `[]`; drop it so the spike rows form the list.
$orig = ($orig -split "`r?`n" | Where-Object { $_.Trim() -ne '[]' }) -join "`n"
$spike = Get-Content (Join-Path $PSScriptRoot 'router-spike.patch.yml') -Raw
Set-Content -Path $patchFile -Value ($orig.TrimEnd() + "`n" + $spike) -Encoding utf8

$dump = & $dsh router-spike --dump-config | Out-String
if ($dump -match 'deepseek-v4-pro' -and $dump -match 'model-router') {
  Write-Host "OK: model-router row is in the composed config with planner deepseek-v4-pro. Next: spike\b1\run.ps1"
} else {
  Write-Warning "model-router row or planner override not found in --dump-config output; check the profile."
}
