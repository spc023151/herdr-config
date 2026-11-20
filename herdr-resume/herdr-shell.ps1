# herdr-core shell (config.toml `shell`): a normal PowerShell with herdr's cwd-tracking
# prompt. If this terminal (HC_TERMINAL_ID) had a Claude or Codex session that never ended
# on purpose (e.g. the PC rebooted), resume it here.
param([switch]$DryRun)

# herdr's own prompt hook, as it starts PowerShell by default (keeps the live folder in sync).
$global:__hc_prompt = $function:prompt
function global:prompt {
  $p = & $global:__hc_prompt
  $l = $ExecutionContext.SessionState.Path.CurrentLocation
  if ($l.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {} }
  $p
}

$global:__hr_file = Join-Path $PSScriptRoot 'sessions.json'

# Codex has no "session ended" hook: when codex returns to this shell normally, forget the
# entry. A reboot kills the shell first, so the entry survives and is resumed.
function global:codex {
  $exe = (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  & $exe @args
  $code = $LASTEXITCODE
  try {
    $t = $env:HC_TERMINAL_ID
    if ($t -and (Test-Path $global:__hr_file)) {
      $m = Get-Content -Raw -Encoding UTF8 $global:__hr_file | ConvertFrom-Json
      if ($m.$t -and $m.$t.kind -eq 'codex') {
        $m.PSObject.Properties.Remove($t)
        [IO.File]::WriteAllText($global:__hr_file, ($m | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
      }
    }
  } catch {}
  $global:LASTEXITCODE = $code
}

$term = $env:HC_TERMINAL_ID
if (-not $term -or -not (Test-Path $global:__hr_file)) { return }
try { $map = Get-Content -Raw -Encoding UTF8 $global:__hr_file | ConvertFrom-Json } catch { return }
$entry = $map.$term
if (-not $entry -or -not $entry.sessionId) { return }
$kind = if ($entry.kind) { $entry.kind } else { 'claude' }

# Already running somewhere (not a reboot)? Then don't start a second copy.
if ($kind -eq 'claude') {
  $live = Get-ChildItem "$env:USERPROFILE\.claude\sessions\*.json" -ErrorAction SilentlyContinue | ForEach-Object {
    try { $s = Get-Content -Raw $_.FullName | ConvertFrom-Json; if ($s.sessionId -eq $entry.sessionId -and (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) { $s } } catch {}
  }
} else {
  $live = Get-CimInstance Win32_Process -Filter "Name='codex.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$($entry.sessionId)*" }
}
if ($live) { Write-Host "[herdr-resume] $kind session $($entry.sessionId) is already running; not resuming."; return }

if ($entry.cwd -and (Test-Path $entry.cwd)) { Set-Location $entry.cwd }
if ($kind -eq 'codex') {
  $flags = @($entry.flags | Where-Object { $_ })
  Write-Host "[herdr-resume] $term -> codex resume $($entry.sessionId) $($flags -join ' ')"
  if ($DryRun) { return }
  codex resume $entry.sessionId @flags
} else {
  Write-Host "[herdr-resume] $term -> claude --resume $($entry.sessionId)"
  if ($DryRun) { return }
  claude --resume $entry.sessionId
}
