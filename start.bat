@echo off
title OpenPortal Remote (Dev)
cd /d "D:\ProjetosVS\TunelSSH"

:: Matar processos anteriores
taskkill /F /IM electron.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Iniciar com npm run dev (Vite + Electron com nodemon)
echo Iniciando OpenPortal Remote em modo desenvolvimento...
echo As alteracoes nos arquivos serao refletidas automaticamente.
npm run dev
