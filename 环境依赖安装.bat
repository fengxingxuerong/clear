@echo off
chcp 936 >nul
title 趣AI味 QuAiWei - 环境依赖安装
cd /d "%~dp0"

echo ================================================
echo    趣AI味 QuAiWei v0.9.5 - 环境依赖安装
echo ================================================
echo.

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js！
    echo.
    echo 依赖只有一项：Node.js 18 或更高版本。
    echo 下载：https://nodejs.org/ （选 LTS 版，安装时一路下一步）
    echo 装完后重新双击本文件。
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set "NODEV=%%i"
echo [1/2] Node.js 已就绪（%NODEV%）
echo.

rem ---- 2. 安装 npm 依赖 ----
echo [2/2] 正在安装项目依赖（react / vite / typescript 等，约 1~2 分钟）...
echo.
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。常见原因及解决办法：
    echo   1. 网络不通公司内网 → 换网络
    echo   2. 官方源慢/超时 → 先执行下面命令换国内镜像再重试：
    echo      npm config set registry https://registry.npmmirror.com
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================
echo    依赖安装完成！双击「一键启动.bat」即可使用
echo ================================================
echo.
pause
exit /b 0
