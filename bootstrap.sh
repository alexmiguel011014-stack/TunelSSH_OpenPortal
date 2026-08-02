#!/usr/bin/env bash
# =====================================================================
# SETUP DE AMBIENTE PORTÁTIL & CHECAGEM GLOBAL (LINUX/MAC)
# Mesma lógica do bootstrap.ps1: tem -> usa | não tem -> instala
# =====================================================================
set -euo pipefail

echo "🔍 Verificando ferramentas globais do sistema..."

# 1. Node.js & NPM
if ! command -v node &>/dev/null; then
    echo "❌ [PENDENTE] Node.js não encontrado! Instale em: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js detectado."

# 2. GitHub CLI
if ! command -v gh &>/dev/null; then
    echo "⚠️ GitHub CLI não encontrado. Instalando..."
    if command -v brew &>/dev/null; then
        brew install gh
    elif command -v apt &>/dev/null; then
        sudo apt install -y gh
    else
        echo "👉 Instale manualmente: https://cli.github.com/"
    fi
else
    echo "✅ GitHub CLI (gh) já instalado."
fi

# 3. Graphify
if ! command -v graphify &>/dev/null; then
    echo "⚠️ Graphify não encontrado. Instalando..."
    if command -v pipx &>/dev/null; then
        pipx install graphifyy
    elif command -v pip &>/dev/null; then
        pip install graphifyy
    else
        echo "👉 Python não encontrado. Instale e rode: pip install graphifyy"
    fi
else
    echo "✅ Graphify já instalado."
fi

# 4. RepoMix, Biome, TypeScript (globais via NPM)
echo "📦 Verificando utilitários globais via NPM..."
for pkg in "repomix:repomix" "biome:@biomejs/biome" "tsc:typescript"; do
    cmd="${pkg%%:*}"; name="${pkg##*:}"
    if ! command -v "$cmd" &>/dev/null; then
        echo "⚠️ $name não encontrado. Instalando globalmente..."
        npm install -g "$name"
    else
        echo "✅ $name já instalado."
    fi
done

# =====================================================================
# EXECUÇÃO LOCAL NO PROJETO NOVO
# =====================================================================
echo ""
echo "🚀 Executando ferramentas de otimização no projeto..."
repomix
graphify .

echo ""
echo "🎉 Ambiente 100% configurado para o OpenCode!"
