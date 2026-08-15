@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [KB TradePilot] Node.js 18 이상이 필요합니다.
  echo https://nodejs.org 에서 Node.js LTS를 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
)

echo [KB TradePilot] 메모장에서 ANTHROPIC_API_KEY 값만 본인의 키로 입력하세요.
echo ANTHROPIC_MODEL 기본값은 미리 들어 있으며, 계정에서 지원되지 않을 때만 변경하세요.
echo 키를 입력하지 않으면 로컬 설명 모드로 안전하게 실행됩니다.
start "" /wait notepad.exe ".env"

echo [KB TradePilot] 설정을 확인한 뒤 앱을 시작합니다.
call START_DEMO.cmd

endlocal
