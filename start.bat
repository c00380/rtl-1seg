@echo off
setlocal
cd /d "%~dp0"
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "$url = 'http://localhost:8000/'; for ($attempt = 0; $attempt -lt 100; $attempt++) { try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process $url; exit } } catch {}; Start-Sleep -Milliseconds 200 }; Write-Host ('Open ' + $url + ' manually.')"
call npm start
if errorlevel 1 pause
endlocal
