@echo off
chcp 65001 >nul
title 趣AI味 QuAiWei v0.6.0 - 一键启动
cd /d "%~dp0"

echo ================================================
echo    趣AI味 QuAiWei v0.6.0 - 一键启动
echo    把 AI 写的文章改得更像人写的
echo    本地引擎离线可用 + 可选 LLM + 朱雀增强
echo ================================================
echo.

rem ---- 0. 检测已有服务，直接打开浏览器 ----
curl -s -o nul --max-time 3 http://localhost:5173
if not errorlevel 1 (
    echo 检测到已有服务在运行，直接打开页面...
    start "" http://localhost:5173
    exit /b 0
)

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。
    echo.
    echo 请先安装 Node.js 18 或更高版本：https://nodejs.org/ 下载 LTS 版一路下一步安装。
    echo 安装完成后再次双击本文件即可。
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set "NODEV=%%i"
rem ---- 1.5 版本门槛校验（项目要求 Node 18+，Vite 6 最低 Node 18）----
set "NODE_MAJOR=%NODEV:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%a"
if %NODE_MAJOR% LSS 18 (
    echo [错误] 当前 Node.js 版本为 %NODEV%，低于项目要求的 Node 18。
    echo.
    echo Vite 6 构建链需要 Node 18 及以上，请到 https://nodejs.org/ 下载 LTS 版升级。
    echo 安装完成后再次双击本文件即可。
    echo.
    pause
    exit /b 1
)
echo [1/3] Node.js 已就绪：%NODEV%。

rem ---- 2. 安装依赖 ----
if not exist "node_modules\vite" (
    echo [2/3] 首次运行，正在安装依赖（约 1~2 分钟，只需一次）...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败。检查网络（公司网络可能需要配置 npm 代理）：
        echo    npm config set registry https://registry.npmmirror.com
        echo 然后再次双击本文件。
        echo.
        pause
        exit /b 1
    )
) else (
    echo [2/3] 依赖已就绪，无需安装
)

rem ---- 3. 启动服务 ----
echo [3/3] 正在启动服务...
echo.
echo  * 如果浏览器没有自动打开，请手动访问 http://localhost:5173
echo  * 使用期间请保持本窗口打开，关闭即停止服务
echo  * 首次使用建议：点右上角"设置"配置 LLM 或开启朱雀增强
echo  * 朱雀增强：开启后叠加方言/插入语/括号自语等反检测特征
echo.

start "QuAiWei 服务" cmd /c "npm run dev"
ping -n 9 127.0.0.1 >nul
start "" http://localhost:5173

echo 服务已启动，本窗口将在几秒后自动关闭。
ping -n 4 127.0.0.1 >nul
exit /b 0
