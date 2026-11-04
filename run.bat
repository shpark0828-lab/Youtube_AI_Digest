@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion
title Youtube AI Digest
echo ================================================================
echo    [Youtube AI Digest]
echo    매일 아침 09:00 24시간 이내 신규 영상 자동 조사 및 심층 요약 웹앱
echo ================================================================
echo.

cd /d "%~dp0"

echo [1/3] 포트 가용성 확인 중...
set START_PORT=8070
set PORT=%START_PORT%

:check_port
netstat -ano | findstr /C:":!PORT! " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto :port_occupied
goto :port_available

:port_occupied
echo [안내] 포트 !PORT!번이 이미 사용 중입니다. 다음 포트를 확인합니다...
set /a PORT+=1
if !PORT! gtr 8100 goto :port_error
goto :check_port

:port_error
echo [오류] 8070~8100 범위 내에서 사용 가능한 포트를 찾을 수 없습니다.
pause
exit /b 1

:port_available
if !PORT! neq %START_PORT% echo [알림] 기본 포트 %START_PORT%번 사용 중 - 대체 포트 !PORT!번으로 실행합니다.
if !PORT! equ %START_PORT% echo [알림] 기본 포트 !PORT!번 사용 가능 확인.
echo.

echo [2/3] 서버 가동 감지 후 브라우저 자동 오픈 대기열 등록 [http://127.0.0.1:!PORT!]...
start /b "" powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 60; $i++) { try { (New-Object System.Net.Sockets.TcpClient('127.0.0.1', !PORT!)).Close(); Start-Process 'http://127.0.0.1:!PORT!'; break } catch { Start-Sleep -Milliseconds 250 } }"

echo [3/3] FastAPI 및 스케줄러 가동 중입니다. [서버 준비 완료 시 브라우저 자동 오픈]
set PORT=!PORT!
python app.py --port !PORT!

pause
