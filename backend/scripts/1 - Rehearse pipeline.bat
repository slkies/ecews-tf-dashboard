@echo off
REM ============================================================
REM  REHEARSAL - changes nothing.
REM
REM  Double-click this first. It reads everything, reports what
REM  it would do, and writes not a single file. Nothing you do
REM  here can damage anything, so run it as often as you like.
REM
REM  Takes about 10 minutes, most of it decrypting the export.
REM  It looks frozen on the "treatment list" line. Let it run.
REM ============================================================
title Rehearse pipeline (dry run)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0weekly.ps1"
echo.
echo ============================================================
echo  Nothing was written. If the numbers above look right,
echo  run "2 - Run pipeline.bat".
echo ============================================================
echo.
pause
