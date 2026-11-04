@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion
title Youtube AI Digest - Server Stop
echo ================================================================
echo    [Youtube AI Digest]
echo    웹앱 서버 [포트 8070~8079] 종료 중...
echo ================================================================

set KILLED=0
for /L %%p in (8070,1,8079) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr /C:":%%p " ^| findstr LISTENING') do (
        echo 포트 %%p 점유 프로세스 [PID: %%a] 종료 중...
        taskkill /F /PID %%a > nul 2>&1
        set /a KILLED+=1
    )
)

echo.
if !KILLED! gtr 0 (
    echo 서버 프로세스가 정상적으로 종료되었습니다.
) else (
    echo 실행 중인 서버 프로세스 [8070~8079 포트]를 찾을 수 없습니다.
)
pause
