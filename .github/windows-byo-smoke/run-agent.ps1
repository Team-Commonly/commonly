# Runs `commonly agent run` against the local stub for a fixed time, then
# prints what the listener printed and what it asked the stub for.
param([string]$Label, [int]$Seconds = 40)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $env:RUNNER_TEMP "agent-$Label.txt"
$stubOut = Join-Path $env:RUNNER_TEMP "stub-$Label.txt"

# A fresh identity per run: the token file from a previous run would win.
Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE '.commonly') -ErrorAction SilentlyContinue

$stub = Start-Process -FilePath node -ArgumentList @("$here\stub.mjs", '47123') -RedirectStandardOutput $stubOut -RedirectStandardError "$stubOut.err" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

$env:COMMONLY_API_URL = 'http://127.0.0.1:47123'
$env:COMMONLY_AGENT_TOKEN = 'cm_agent_windows_smoke_not_a_real_token'
$agent = Start-Process -FilePath cmd.exe -ArgumentList '/c', "commonly agent run win-smoke > `"$out`" 2>&1" -PassThru -NoNewWindow
Start-Sleep -Seconds $Seconds
& taskkill.exe /T /F /PID $agent.Id | Out-Null
& taskkill.exe /T /F /PID $stub.Id | Out-Null

Write-Output "===== [$Label] commonly agent run output ====="
Get-Content $out -ErrorAction SilentlyContinue
Write-Output "===== [$Label] requests the stub received ====="
Get-Content $stubOut -ErrorAction SilentlyContinue
Get-Content "$stubOut.err" -ErrorAction SilentlyContinue
Write-Output "===== [$Label] files under ~\.commonly ====="
Get-ChildItem -Recurse -Force (Join-Path $env:USERPROFILE '.commonly') -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
