@echo off
REM ============================================================
REM  THE REAL RUN - this one writes files.
REM
REM  Only run this after the rehearsal looked right.
REM
REM  It updates the vault (backing it up first), updates the
REM  register, and produces the de-identified file to upload.
REM  Late-reported results are included.
REM
REM  It does NOT migrate keys. That was a one-time changeover
REM  and must never be repeated.
REM
REM  Takes about 10 minutes.
REM ============================================================
title Run pipeline (writes files)
echo.
echo  This will write files. Close this window now if you meant
echo  to rehearse instead - that is "1 - Rehearse pipeline.bat".
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0weekly.ps1" -Go -IncludeLate
echo.
echo ============================================================
echo  Upload the file named above on the Admin tab.
echo  Set the date field to the as-of date, not today.
echo ============================================================
echo.
pause
