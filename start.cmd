@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo [1/2] 首次运行，先构建...
  call npm run build
)

echo [2/2] 启动本地服务并用 Chrome 打开...
start "" http://localhost:8080/
node serve.mjs 8080
