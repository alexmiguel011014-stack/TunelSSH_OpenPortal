@echo off
chcp 65001 >nul
title OpenPortal Remote - Build

echo ========================================
echo  OpenPortal Remote - Build do Instalador
echo ========================================
echo.
echo Este script precisa de privilegios de administrador
echo para configurar o Firewall do Windows.
echo.
echo Se nao executar como admin, o instalador ainda sera
echo criado, mas a regra de firewall precisara ser adicionada
echo manualmente depois.
echo.
echo Pressione qualquer tecla para continuar...
pause >nul

echo.
echo [1/2] Compilando o renderer (React + Vite)...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo ERRO: Falha ao compilar o renderer
    pause
    exit /b 1
)
echo OK - Renderer compilado
echo.

echo [2/2] Gerando instalador...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win nsis --x64
if %ERRORLEVEL% neq 0 (
    echo ERRO: Falha ao gerar instalador
    pause
    exit /b 1
)
echo.
echo ========================================
echo  BUILD CONCLUIDO COM SUCESSO!
echo ========================================
echo.
echo Instalador: dist-electron\OpenPortal Remote Setup 1.0.0.exe
echo.
echo Proximos passos:
echo   1. Va em https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal
echo   2. Crie uma nova Release
echo   3. Anexe o instalador .exe e o .blockmap
echo   4. Pronto - usuarios vao receber atualizacoes automaticamente
echo.
pause
