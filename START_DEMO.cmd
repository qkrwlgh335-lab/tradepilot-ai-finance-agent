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

echo [KB TradePilot] 서버 준비 후 자동으로 브라우저를 엽니다.
echo 오프라인 데모: KB_MARKET_AUTO_REFRESH=off 로 자동 갱신을 끌 수 있습니다.
echo .env에 외부 AI 키와 모델이 설정되어 있으면 로컬 프록시도 자동 시작합니다.
call npm start

endlocal
