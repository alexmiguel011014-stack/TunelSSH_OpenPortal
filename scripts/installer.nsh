; Adiciona regra no Firewall do Windows para o File Server (porta 5001)
; =====================================================================
; Isso permite que outros PCs na rede Tailscale enviem arquivos para este PC
; sem que o Windows Firewall bloqueie a conexao.

!macro customInstall
  DetailPrint "Configurando Firewall do Windows..."
  nsExec::ExecToStack 'netsh advfirewall firewall add rule name="OpenPortal Remote - File Server" dir=in action=allow protocol=TCP localport=5001 program="$INSTDIR\OpenPortal Remote.exe" profile=private,domain description="Permite receber arquivos de outros PCs via OpenPortal Remote"'
  Pop $0
  DetailPrint "Firewall rule result: $0"
!macroend

!macro customUnInstall
  DetailPrint "Removendo regra do Firewall do Windows..."
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="OpenPortal Remote - File Server"'
  Pop $0
  DetailPrint "Firewall rule removal result: $0"
!macroend
