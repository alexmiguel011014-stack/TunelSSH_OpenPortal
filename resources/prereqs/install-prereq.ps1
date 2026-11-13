# Instala um programa de que o OpenPortal depende (GOALS 22): Tailscale ou TightVNC 2.
#
# Usado pelo instalador (scripts/installer.nsh) e pelo app (src/main/system/prerequisites-ipc.js). E o
# unico lugar com o catalogo: a URL oficial, quem precisa ter assinado o arquivo e os argumentos do
# msiexec. O nome vem de fora, mas so vale se for uma chave do catalogo; nenhum outro texto de fora
# entra em comando.
#
# Passos: baixa por HTTPS numa pasta nova, confere a assinatura Authenticode (Valid e o assinante
# esperado), roda o msiexec e apaga tudo. Nunca executa um arquivo cuja assinatura nao confere.
#
# Codigos de saida (o instalador do Windows os traduz em frases):
#   0 instalado | 2 instalado, o Windows pede reinicio | 10 programa desconhecido | 11 nao baixou
#   12 assinatura invalida | 13 cancelado | 14 o msiexec falhou | 15 outro erro
# O resultado vai tambem em -ResultFile (JSON: ok, code, restartNeeded, message), para o app.
#
# Este arquivo e UTF-8 com BOM de proposito: sem o BOM o Windows PowerShell 5.1 le os acentos errado.
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'
# Sem a barra de progresso o Invoke-WebRequest do PowerShell 5.1 baixa dezenas de vezes mais devagar.
$ProgressPreference = 'SilentlyContinue'

# Tailscale: o endereco "latest" redireciona para a versao atual. TightVNC: a 2.8 (GPL), a que o app
# sabe configurar (src/main/system/host-vnc.js); a 4.0 guarda a configuracao em outro lugar.
# Os argumentos do TightVNC deixam so o servidor, como servico, sem excecao de firewall e so com
# conexoes locais; sem senha na linha de comando (o app define uma depois, em "Configurar TightVNC").
# Conferido em 2026-10-28 contra os próprios MSI (leitura das tabelas, sem instalar): o certificado do
# Tailscale 1.104.4 tem CN=Tailscale Inc. e o do TightVNC 2.8.90 tem CN=OOO GlavSoft (o campo
# Manufacturer do MSI diz "GlavSoft LLC", mas o que vale é o certificado). O TightVNC tem os recursos
# Server e Viewer (ADDLOCAL=Server) e as propriedades SET_/VALUE_OF_ abaixo; SERVER_ADD_FIREWALL_EXCEPTION
# vale 1 por padrão, por isso o 0. Em instalação silenciosa o serviço é o tvnserver e, sem SET_PASSWORD,
# a verificação de senhas não roda: o app define a senha depois.
$catalog = @{
  tailscale = @{
    Label   = 'Tailscale'
    Url     = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
    Hosts   = @('pkgs.tailscale.com')
    Signers = @('Tailscale Inc.')
    Args    = @('/qn', '/norestart')
  }
  tightvnc = @{
    Label   = 'TightVNC'
    Url     = 'https://www.tightvnc.com/download/2.8.90/tightvnc-2.8.90-gpl-setup-64bit.msi'
    Hosts   = @('www.tightvnc.com')
    Signers = @('OOO GlavSoft')
    Args    = @(
      '/qn', '/norestart',
      'ADDLOCAL=Server',
      'SERVER_REGISTER_AS_SERVICE=1',
      'SERVER_ADD_FIREWALL_EXCEPTION=0',
      'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=1',
      'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1',
      'SET_LOOPBACKONLY=1', 'VALUE_OF_LOOPBACKONLY=1'
    )
  }
}

function Finish([bool]$ok, [int]$exitCode, [int]$code, [bool]$restart, [string]$message) {
  if ($ResultFile) {
    $json = @{ ok = $ok; code = $code; restartNeeded = $restart; message = $message } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Output $message
  exit $exitCode
}

function Test-SignerMatches($signature, [string[]]$signers) {
  if (-not $signature.SignerCertificate) { return $false }
  foreach ($signer in $signers) {
    $pattern = '(^|, )CN=' + [regex]::Escape($signer) + '(,|$)'
    if ($signature.SignerCertificate.Subject -match $pattern) { return $true }
  }
  return $false
}

if (-not $catalog.ContainsKey($Name)) {
  Finish $false 10 0 $false "Programa desconhecido: o OpenPortal só instala 'tailscale' e 'tightvnc'."
}

$entry = $catalog[$Name]
$label = $entry.Label
$work = Join-Path ([IO.Path]::GetTempPath()) ('openportal-prereq-' + [guid]::NewGuid().ToString('N'))

try {
  $uri = [Uri]$entry.Url
  if ($uri.Scheme -ne 'https' -or ($entry.Hosts -notcontains $uri.Host)) {
    Finish $false 15 0 $false "O endereço de download do $label não é o oficial."
  }

  New-Item -ItemType Directory -Path $work | Out-Null
  $msi = Join-Path $work ($Name + '.msi')

  # O Windows PowerShell 5.1 nao liga o TLS 1.2 sozinho em todos os PCs.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $downloaded = $true
  try {
    Invoke-WebRequest -Uri $entry.Url -OutFile $msi -UseBasicParsing -TimeoutSec 300
  } catch {
    $downloaded = $false
  }
  if (-not $downloaded) {
    Finish $false 11 0 $false "Não foi possível baixar o $label. Confira a conexão com a internet."
  }

  # Mesmo que um redirecionamento leve a outro site, nada roda sem a assinatura certa.
  $signature = Get-AuthenticodeSignature -FilePath $msi
  if ($signature.Status -ne 'Valid' -or -not (Test-SignerMatches $signature $entry.Signers)) {
    Finish $false 12 0 $false "O arquivo baixado do $label não tem a assinatura digital esperada e não foi instalado."
  }

  $argumentLine = '/i "' + $msi + '" ' + ($entry.Args -join ' ')
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $argumentLine -Wait -PassThru
  $code = [int]$process.ExitCode

  if ($code -eq 0) { Finish $true 0 0 $false "$label instalado." }
  if ($code -eq 3010) { Finish $true 2 3010 $true "$label instalado. O Windows pede para reiniciar o computador." }
  if ($code -eq 1602 -or $code -eq 1623) { Finish $false 13 $code $false "A instalação do $label foi cancelada." }
  Finish $false 14 $code $false "O instalador do $label falhou (código $code)."
} catch {
  Finish $false 15 0 $false "Não foi possível instalar o ${label}: $($_.Exception.Message)"
} finally {
  if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
