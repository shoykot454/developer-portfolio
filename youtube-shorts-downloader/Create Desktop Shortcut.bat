@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop');" ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Video Downloader.lnk'));" ^
  "$s.TargetPath=(Join-Path (Get-Location) 'Start Downloader.bat');" ^
  "$s.WorkingDirectory=(Get-Location).Path;" ^
  "$s.IconLocation=(Join-Path (Get-Location) 'icon.ico');" ^
  "$s.Description='YouTube and Facebook video downloader';" ^
  "$s.Save();" ^
  "Write-Host ''; Write-Host ' Done! The Video Downloader icon is now on your Desktop.' -ForegroundColor Green"
if errorlevel 1 echo  Could not create the shortcut.
echo.
pause
