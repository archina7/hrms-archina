# 테스트용 로컬 서버(wrangler pages dev, workerd)와 테스트 브라우저(원격 디버깅 Chrome)를 모두 종료한다.
# Bash의 백그라운드 작업 중지만으로는 workerd 자식 프로세스가 남아 포트·파일을 잡고 있는 경우가 있어 필요하다.
# 사용: pwsh -File .claude/skills/final-check/scripts/stop-test-servers.ps1
$match = { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler.*pages dev') -or $_.Name -eq 'workerd.exe' -or ($_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'remote-debugging-port=93') }
$procs = Get-CimInstance Win32_Process | Where-Object $match
foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 1
$left = @(Get-CimInstance Win32_Process | Where-Object $match).Count
"종료 $(@($procs).Count)개, 남은 프로세스 $left개"
