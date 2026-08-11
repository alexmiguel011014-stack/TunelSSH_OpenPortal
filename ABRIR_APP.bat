@echo off
chcp 65001 >nul
title OpenPortal Remote (dev)

echo ========================================
echo  OpenPortal Remote - Rodando do codigo-fonte
echo ========================================
echo.
echo Encerrando instancias antigas (se houver)...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-dev-instances.ps1"

echo Aguardando portas liberarem...
timeout /t 2 /nobreak >nul

echo.
echo Iniciando (minimizado na barra de tarefas)...
echo.

start "OpenPortal Remote (dev)" /min cmd /c "npm run dev"