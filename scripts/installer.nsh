; Hooks do electron-builder para instalar/desinstalar.
; Não há mais regras de firewall: o módulo de transferência de arquivos
; (porta 5001) foi removido.
;
; GOALS 22 — página "Programas necessários": depois da escolha da pasta, o instalador procura o
; Tailscale e o TightVNC e oferece instalar o que falta. Quem instala é resources/prereqs/install-prereq.ps1
; (o mesmo script do app), que baixa do site oficial e confere a assinatura digital. A página não
; aparece em atualizações (isUpdated) nem em instalação silenciosa, e uma falha nunca impede a
; instalação do OpenPortal. Este arquivo é UTF-8 com BOM: o NSIS Unicode só lê os acentos assim.

!include nsDialogs.nsh
!include LogicLib.nsh

; A ordem das páginas está em assistedInstaller.nsh: esta fica depois da pasta e antes da cópia dos
; arquivos. As funções e os textos ficam em customHeader, que o electron-builder insere depois dos
; idiomas (os LangString precisam deles).
!macro customPageAfterChangeDir
  Page custom PrereqPageCreate PrereqPageLeave
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var /GLOBAL PrereqDialog
    Var /GLOBAL PrereqTsBox
    Var /GLOBAL PrereqVncBox
    Var /GLOBAL PrereqTsFound
    Var /GLOBAL PrereqVncFound
    Var /GLOBAL PrereqTsWant
    Var /GLOBAL PrereqVncWant
    Var /GLOBAL PrereqFailures
    Var /GLOBAL PrereqRestart

    LangString S_PrereqTitle ${LANG_PORTUGUESEBR} "Programas necessários"
    LangString S_PrereqTitle ${LANG_ENGLISH} "Required programs"
    LangString S_PrereqSubtitle ${LANG_PORTUGUESEBR} "O OpenPortal usa o Tailscale e o TightVNC."
    LangString S_PrereqSubtitle ${LANG_ENGLISH} "OpenPortal uses Tailscale and TightVNC."
    LangString S_PrereqIntro ${LANG_PORTUGUESEBR} "Veja o que este computador já tem. Marque o que quiser instalar agora: o OpenPortal baixa os programas dos sites oficiais."
    LangString S_PrereqIntro ${LANG_ENGLISH} "See what this computer already has. Check what you want to install now: OpenPortal downloads the programs from the official sites."
    LangString S_PrereqTsMissing ${LANG_PORTUGUESEBR} "Instalar o Tailscale (recomendado)"
    LangString S_PrereqTsMissing ${LANG_ENGLISH} "Install Tailscale (recommended)"
    LangString S_PrereqTsWhy ${LANG_PORTUGUESEBR} "Necessário para conectar a outros PCs e para ser acessado por eles."
    LangString S_PrereqTsWhy ${LANG_ENGLISH} "Needed to connect to other PCs and to be reached by them."
    LangString S_PrereqTsOk ${LANG_PORTUGUESEBR} "Tailscale: já instalado."
    LangString S_PrereqTsOk ${LANG_ENGLISH} "Tailscale: already installed."
    LangString S_PrereqVncMissing ${LANG_PORTUGUESEBR} "Instalar o TightVNC"
    LangString S_PrereqVncMissing ${LANG_ENGLISH} "Install TightVNC"
    LangString S_PrereqVncWhy ${LANG_PORTUGUESEBR} "Só se outros PCs vão controlar este pelo VNC. No Windows Pro, Enterprise ou Education o RDP serve sem ele."
    LangString S_PrereqVncWhy ${LANG_ENGLISH} "Only if other PCs will control this one over VNC. On Windows Pro, Enterprise or Education, RDP works without it."
    LangString S_PrereqVncOk ${LANG_PORTUGUESEBR} "TightVNC: já instalado."
    LangString S_PrereqVncOk ${LANG_ENGLISH} "TightVNC: already installed."
    LangString S_PrereqFooter ${LANG_PORTUGUESEBR} "Se algo falhar ou você pular esta etapa, o OpenPortal continua instalando e oferece de novo ao abrir."
    LangString S_PrereqFooter ${LANG_ENGLISH} "If anything fails or you skip this step, OpenPortal still installs and offers it again when it opens."
    LangString S_PrereqRunning ${LANG_PORTUGUESEBR} "Baixando e instalando $1..."
    LangString S_PrereqRunning ${LANG_ENGLISH} "Downloading and installing $1..."
    LangString S_PrereqDone ${LANG_PORTUGUESEBR} "$1 instalado."
    LangString S_PrereqDone ${LANG_ENGLISH} "$1 installed."
    LangString S_PrereqRestart ${LANG_PORTUGUESEBR} "O Windows pede para reiniciar o computador para terminar a instalação do $1."
    LangString S_PrereqRestart ${LANG_ENGLISH} "Windows asks to restart the computer to finish installing $1."
    LangString S_PrereqFailedIntro ${LANG_PORTUGUESEBR} "O OpenPortal foi instalado, mas não foi possível instalar:"
    LangString S_PrereqFailedIntro ${LANG_ENGLISH} "OpenPortal was installed, but these could not be installed:"
    LangString S_PrereqFailedOutro ${LANG_PORTUGUESEBR} "O OpenPortal oferece de novo ao abrir."
    LangString S_PrereqFailedOutro ${LANG_ENGLISH} "OpenPortal offers them again when it opens."
    LangString S_ReasonNet ${LANG_PORTUGUESEBR} "sem acesso à internet"
    LangString S_ReasonNet ${LANG_ENGLISH} "no internet access"
    LangString S_ReasonSig ${LANG_PORTUGUESEBR} "a assinatura digital do arquivo não confere"
    LangString S_ReasonSig ${LANG_ENGLISH} "the file's digital signature does not match"
    LangString S_ReasonCancel ${LANG_PORTUGUESEBR} "cancelado"
    LangString S_ReasonCancel ${LANG_ENGLISH} "cancelled"
    LangString S_ReasonFailed ${LANG_PORTUGUESEBR} "o instalador do programa falhou"
    LangString S_ReasonFailed ${LANG_ENGLISH} "the program's installer failed"
    LangString S_ReasonOther ${LANG_PORTUGUESEBR} "erro inesperado"
    LangString S_ReasonOther ${LANG_ENGLISH} "unexpected error"

    ; Define $PrereqTsFound e $PrereqVncFound ("1" ou "0"): o serviço do Tailscale, o serviço do
    ; TightVNC 2 (tvnserver) ou qualquer programa "TightVNC..." na lista de programas instalados
    ; (assim um TightVNC 4 também conta como instalado e não ganha um segundo TightVNC por cima).
    Function PrereqDetect
      StrCpy $PrereqTsFound "0"
      StrCpy $PrereqVncFound "0"

      ClearErrors
      ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\Tailscale" "ImagePath"
      ${IfNot} ${Errors}
        StrCpy $PrereqTsFound "1"
      ${EndIf}

      ClearErrors
      ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\tvnserver" "ImagePath"
      ${IfNot} ${Errors}
        StrCpy $PrereqVncFound "1"
      ${EndIf}

      ${If} $PrereqVncFound == "0"
        StrCpy $1 0
        prereq_scan:
          EnumRegKey $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $1
          StrCmp $2 "" prereq_scan_done
          ReadRegStr $3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$2" "DisplayName"
          StrCpy $4 $3 8
          StrCmp $4 "TightVNC" 0 prereq_scan_next
          StrCpy $PrereqVncFound "1"
          Goto prereq_scan_done
        prereq_scan_next:
          IntOp $1 $1 + 1
          Goto prereq_scan
        prereq_scan_done:
      ${EndIf}
    FunctionEnd

    Function PrereqPageCreate
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      ${If} ${Silent}
        Abort
      ${EndIf}

      Call PrereqDetect
      ${If} $PrereqTsFound == "1"
      ${AndIf} $PrereqVncFound == "1"
        Abort
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "$(S_PrereqTitle)" "$(S_PrereqSubtitle)"
      nsDialogs::Create 1018
      Pop $PrereqDialog
      ${If} $PrereqDialog == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 26u "$(S_PrereqIntro)"
      Pop $0

      ${If} $PrereqTsFound == "1"
        ${NSD_CreateLabel} 0 34u 100% 12u "$(S_PrereqTsOk)"
        Pop $0
      ${Else}
        ${NSD_CreateCheckbox} 0 34u 100% 12u "$(S_PrereqTsMissing)"
        Pop $PrereqTsBox
        ${NSD_CreateLabel} 12u 48u 95% 22u "$(S_PrereqTsWhy)"
        Pop $0
        ; Na primeira vez o Tailscale vem marcado; ao voltar a esta página vale o que a pessoa escolheu.
        ${If} $PrereqTsWant != "0"
          ${NSD_Check} $PrereqTsBox
        ${EndIf}
      ${EndIf}

      ${If} $PrereqVncFound == "1"
        ${NSD_CreateLabel} 0 76u 100% 12u "$(S_PrereqVncOk)"
        Pop $0
      ${Else}
        ${NSD_CreateCheckbox} 0 76u 100% 12u "$(S_PrereqVncMissing)"
        Pop $PrereqVncBox
        ${NSD_CreateLabel} 12u 90u 95% 22u "$(S_PrereqVncWhy)"
        Pop $0
        ${If} $PrereqVncWant == "1"
          ${NSD_Check} $PrereqVncBox
        ${EndIf}
      ${EndIf}

      ${NSD_CreateLabel} 0 118u 100% 22u "$(S_PrereqFooter)"
      Pop $0

      nsDialogs::Show
    FunctionEnd

    Function PrereqPageLeave
      ${If} $PrereqTsFound == "0"
        ${NSD_GetState} $PrereqTsBox $PrereqTsWant
      ${EndIf}
      ${If} $PrereqVncFound == "0"
        ${NSD_GetState} $PrereqVncBox $PrereqVncWant
      ${EndIf}
    FunctionEnd

    ; $0 = nome no script ("tailscale" ou "tightvnc"), $1 = nome para mostrar.
    Function PrereqRunOne
      DetailPrint "$(S_PrereqRunning)"
      ${If} ${FileExists} "$INSTDIR\resources\prereqs\install-prereq.ps1"
        ; nsExec::Exec (e não ExecToLog): a saída do script vem em outra página de código e
        ; trocaria os acentos; as frases mostradas aqui vêm do código de saída.
        ; O instalador é de 32 bits: sem desligar o redirecionamento, $SYSDIR aponta para o
        ; PowerShell de 32 bits (SysWOW64).
        ${DisableX64FSRedirection}
        nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\prereqs\install-prereq.ps1" -Name $0'
        Pop $2
        ${EnableX64FSRedirection}
      ${Else}
        StrCpy $2 "15"
      ${EndIf}

      ${If} $2 == "0"
        DetailPrint "$(S_PrereqDone)"
      ${ElseIf} $2 == "2"
        DetailPrint "$(S_PrereqDone)"
        StrCpy $PrereqRestart "$PrereqRestart$(S_PrereqRestart)$\r$\n"
      ${Else}
        ${If} $2 == "11"
          StrCpy $3 "$(S_ReasonNet)"
        ${ElseIf} $2 == "12"
          StrCpy $3 "$(S_ReasonSig)"
        ${ElseIf} $2 == "13"
          StrCpy $3 "$(S_ReasonCancel)"
        ${ElseIf} $2 == "14"
          StrCpy $3 "$(S_ReasonFailed)"
        ${Else}
          StrCpy $3 "$(S_ReasonOther)"
        ${EndIf}
        DetailPrint "$1: $3"
        StrCpy $PrereqFailures "$PrereqFailures$1: $3$\r$\n"
      ${EndIf}
    FunctionEnd

    Function PrereqInstallChosen
      StrCpy $PrereqFailures ""
      StrCpy $PrereqRestart ""
      ${If} $PrereqTsWant == "1"
        StrCpy $0 "tailscale"
        StrCpy $1 "Tailscale"
        Call PrereqRunOne
      ${EndIf}
      ${If} $PrereqVncWant == "1"
        StrCpy $0 "tightvnc"
        StrCpy $1 "TightVNC"
        Call PrereqRunOne
      ${EndIf}

      ${IfNot} ${Silent}
        ${If} $PrereqFailures != ""
        ${OrIf} $PrereqRestart != ""
          StrCpy $2 ""
          ${If} $PrereqFailures != ""
            StrCpy $2 "$(S_PrereqFailedIntro)$\r$\n$PrereqFailures$(S_PrereqFailedOutro)$\r$\n$\r$\n"
          ${EndIf}
          MessageBox MB_OK|MB_ICONINFORMATION "$2$PrereqRestart"
        ${EndIf}
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!macro customInstall
  Call PrereqInstallChosen
!macroend

!macro customUnInstall
!macroend
