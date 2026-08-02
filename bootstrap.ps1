# =====================================================================
# SETUP DE AMBIENTE PORTÁTIL & CHECAGEM GLOBAL (WINDOWS + VS CODE)
# =====================================================================
Write-Host "🔍 Verificando ferramentas globais do sistema..." -ForegroundColor Cyan

# 1. Checagem do Node.js & NPM (Necessário para Biome e RepoMix)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ [PENDENTE] Node.js não encontrado!" -ForegroundColor Red
    Write-Host "👉 Por favor, instale o Node.js baixando em: https://nodejs.org/" -ForegroundColor Yellow
    Pause
    Exit
} else {
    Write-Host "✅ Node.js detectado." -ForegroundColor Green
}

# 2. Checagem / Instalação do GitHub CLI (cli/cli)
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️ GitHub CLI não encontrado no PC. Instalando globalmente..." -ForegroundColor Yellow
    winget install --id GitHub.cli --silent --accept-source-agreements --accept-package-agreements
    Write-Host "✅ GitHub CLI instalado com sucesso! (Rode 'gh auth login' no terminal para se conectar)" -ForegroundColor Green
} else {
    Write-Host "✅ GitHub CLI (gh) já instalado no PC." -ForegroundColor Green
}

# 3. Checagem / Instalação do Graphify (Graphify-Labs/graphify)
if (-not (Get-Command graphify -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️ Graphify não encontrado. Instalando globalmente..." -ForegroundColor Yellow
    
    # Tenta via pipx ou pip
    if (Get-Command pipx -ErrorAction SilentlyContinue) {
        pipx install graphifyy
    } elseif (Get-Command pip -ErrorAction SilentlyContinue) {
        pip install graphifyy
    } else {
        Write-Host "👉 Python/Pipx não encontrado. Instale o Python (https://python.org) e rode: pip install graphifyy" -ForegroundColor Yellow
    }
} else {
    Write-Host "✅ Graphify já instalado no PC." -ForegroundColor Green
}

# 4. Checagem / Instalação Global do RepoMix, Biome e TypeScript (Ficam salvos no PC)
Write-Host "📦 Verificando utilitários globais via NPM..." -ForegroundColor Cyan
$npmTools = @(
    @{ Cmd = "repomix"; Pkg = "repomix" },
    @{ Cmd = "biome";   Pkg = "@biomejs/biome" },
    @{ Cmd = "tsc";     Pkg = "typescript" }
)
foreach ($tool in $npmTools) {
    if (-not (Get-Command $tool.Cmd -ErrorAction SilentlyContinue)) {
        Write-Host "⚠️ $($tool.Pkg) não encontrado. Instalando globalmente..." -ForegroundColor Yellow
        npm install -g $tool.Pkg
    } else {
        Write-Host "✅ $($tool.Pkg) já instalado no PC." -ForegroundColor Green
    }
}

# =====================================================================
# EXECUÇÃO LOCAL NO PROJETO NOVO
# =====================================================================
Write-Host "`n🚀 Executando ferramentas de otimização no projeto..." -ForegroundColor Cyan

# Mapeia o projeto em Grafo e XML para economizar tokens do OpenCode Go
repomix
graphify .

Write-Host "`n🎉 Seu PC e o Projeto atual estão 100% configurados para o OpenCode!" -ForegroundColor Green