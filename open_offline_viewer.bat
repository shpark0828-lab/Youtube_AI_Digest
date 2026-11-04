@echo off
chcp 65001 > nul
title Youtube AI Digest - Offline Viewer
echo ================================================================
echo    [Youtube AI Digest - 오프라인 뷰어]
echo    서버 실행 없이 브라우저에서 영구 보관된 요약 리포트를 열람합니다.
echo ================================================================
echo.

cd /d "%~dp0"
start "" "%~dp0offline_viewer.html"
exit
