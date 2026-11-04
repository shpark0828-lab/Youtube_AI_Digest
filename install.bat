@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"
title Youtube AI Digest - Dependency Installer
echo ================================================================
echo    [Youtube AI Digest] 필수 파이썬 패키지 설치
echo ================================================================
echo.
python -m pip install --upgrade pip
pip install -r requirements.txt
echo.
echo ================================================================
echo 패키지 설치가 완료되었습니다. 이제 run.bat을 실행하세요!
echo ================================================================
pause
