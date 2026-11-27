@echo off
title Video Downloader
cd /d "%~dp0"

rem ---- find Python: "python" or the "py" launcher ----
set "PY=python"
where python >nul 2>nul
if not errorlevel 1 goto have_python
set "PY=py"
where py >nul 2>nul
if not errorlevel 1 goto have_python
echo.
echo  Python was not found.
echo  Install it from https://www.python.org/downloads
echo  and tick "Add Python to PATH" during setup. Then run this file again.
echo.
pause
exit /b 1

:have_python
where ffmpeg >nul 2>nul
if not errorlevel 1 goto have_ffmpeg
echo.
echo  WARNING: ffmpeg was not found. Videos may download without sound.
echo  Fix: open Command Prompt and run:  winget install ffmpeg
echo.

:have_ffmpeg
rem ---- first run: install Flask and yt-dlp ----
%PY% -c "import flask, yt_dlp" >nul 2>nul
if not errorlevel 1 goto have_packages
echo  Installing the required packages, please wait...
%PY% -m pip install -r requirements.txt
if errorlevel 1 goto pip_failed

:have_packages
echo  Checking for yt-dlp updates...
%PY% -m pip install -U -q yt-dlp >nul 2>nul

set "OPEN_BROWSER=1"
%PY% app.py
echo.
echo  The downloader has stopped. You can close this window.
pause
exit /b 0

:pip_failed
echo.
echo  Could not install the packages. Check your internet connection and try again.
pause
exit /b 1
