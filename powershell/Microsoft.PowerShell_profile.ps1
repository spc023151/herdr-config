# herdr: a terminal's own shell (started directly by herdr-core, not by a program inside it)
# resumes the Claude/Codex session it had. This covers terminals created before
# ~/.config/herdr-core/config.toml pointed at herdr-shell.ps1: when herdr-core rebuilds a
# terminal it reuses that terminal's original command line, so the script never ran.
# Shells started by Claude, Codex or anything else inside a terminal have another parent and skip this.
if ($env:HC_TERMINAL_ID -and -not $global:__hr_ran) {
  try {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)" -ErrorAction Stop
    if ($parent.Name -like 'herdr-core*' -and $me.CommandLine -notlike '*herdr-shell.ps1*') {
      $global:__hr_ran = $true
      & "$env:USERPROFILE\.claude\herdr-resume\herdr-shell.ps1"
    }
  } catch {}
}
