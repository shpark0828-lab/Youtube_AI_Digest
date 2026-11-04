@echo off
chcp 65001 > nul
title Youtube AI Digest - Data Export
echo ================================================================
echo    [Youtube AI Digest - 오프라인 뷰어 데이터 갱신]
echo ================================================================
echo.

cd /d "%~dp0"
python backend/offline_exporter.py
echo.
pause
