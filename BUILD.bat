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
echo criado, mas a regra de firewall e a assinatura
echo precisarao ser feitas manualmente depois.
echo.
echo Pressione qualquer tecla para continuar...
pause >nul

echo.
echo [1/4] Gerando certificado auto-assinado...
set CERT_PFX=resources\cert.pfx
set CERT_PWD=openportal123

if not exist %CERT_PFX% (
    powershell -Command "$pwd=ConvertTo-SecureString '%CERT_PWD%' -Force -AsPlainText; $cert=New-SelfSignedCertificate -Type Custom -Subject 'CN=OpenPortal Remote, O=OpenPortal, C=BR' -KeyUsage DigitalSignature -FriendlyName 'OpenPortal Remote Code Signing' -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3'); Export-PfxCertificate -Cert $cert -FilePath '%CERT_PFX%' -Password $pwd | Out-Null; Export-Certificate -Cert $cert -FilePath 'resources\cert.cer' -Type CERT | Out-Null; Write-Output 'OK - Certificado criado'"
) else (
    echo OK - Certificado ja existe
)
echo.

echo [2/4] Compilando o renderer (React + Vite)...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo ERRO: Falha ao compilar o renderer
    pause
    exit /b 1
)
echo OK - Renderer compilado
echo.

echo [3/4] Gerando instalador...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win nsis --x64
if %ERRORLEVEL% neq 0 (
    echo ERRO: Falha ao gerar instalador
    pause
    exit /b 1
)
echo OK - Instalador gerado
echo.

echo [4/4] Assinando o instalador...
set SIGNTOOL="C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
if exist %SIGNTOOL% (
    %SIGNTOOL% sign /fd SHA256 /a /f %CERT_PFX% /p %CERT_PWD% /t http://timestamp.digicert.com "dist-electron\OpenPortal Remote Setup 1.0.0.exe" >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        echo OK - Instalador assinado
    ) else (
        echo AVISO: Falha ao assinar (pode ser necessario executar como administrador)
    )
) else (
    echo AVISO: signtool.exe nao encontrado, instalador nao assinado
)
echo.

echo ========================================
echo  BUILD CONCLUIDO COM SUCESSO!
echo ========================================
echo.
echo Instalador: dist-electron\OpenPortal Remote Setup 1.0.0.exe
echo.
echo Para confiar no app em outro PC:
echo   1. Copie resources\cert.cer para o outro PC
echo   2. Execute o .cer e clique em "Instalar Certificado"
echo   3. Escolha "Maquina Local" > "Trusted Root Certification Authorities"
echo   4. Pronto - o SmartScreen nao vai mais bloquear
echo.
echo Proximos passos:
echo   1. Va em https://github.com/alexmiguel011014-stack/TunelSSH_OpenPortal
echo   2. Crie uma nova Release
echo   3. Anexe o instalador .exe e o .blockmap
echo.
pause
