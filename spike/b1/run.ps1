# B1 spike run: one headless task that plans on the root agent and delegates
# once, then counts which model each request used. THIS CALLS THE DEEPSEEK API
# (a few small requests). The headless profile does not share the desktop
# app's stored key: set DEEPSEEK_API_KEY in this PowerShell window first.
$ErrorActionPreference = 'Stop'
if (-not $env:DEEPSEEK_API_KEY) {
  throw 'DEEPSEEK_API_KEY is not set in this window. Set it (e.g. $env:DEEPSEEK_API_KEY = Read-Host -MaskInput) and re-run.'
}
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$task = 'Reply in one short paragraph. First, in your own words, state a one-line plan for computing 17 * 23. Then delegate the arithmetic to exactly one subagent with a self-contained prompt, wait for its answer, and report the result. Do not read or write any files.'

$events = Join-Path $PSScriptRoot 'run-events.jsonl'
$stderr = Join-Path $PSScriptRoot 'run-stderr.txt'
Push-Location $env:TEMP
try {
  & $dsh --profile router-spike --json $task 2> $stderr | Out-File -FilePath $events -Encoding utf8
} finally { Pop-Location }
Write-Host "Run events: $events"
$diag = Get-Content $stderr -ErrorAction SilentlyContinue | Select-String 'failed to import|did not activate|MISSING_CREDENTIAL'
if ($diag) { Write-Warning ("Harness diagnostics:`n" + ($diag -join "`n")) }
$final = Get-Content $events | Where-Object { $_ -match '"type":"final"' }
if ($final -match '"kind":"error"') { Write-Warning "The run ended with an error: $final" }
node (Join-Path $PSScriptRoot 'check-models.mjs') $since
