// Regras dos programas necessários (GOALS 22), sem React: dado o que o PC tem, diz se uma tela pode
// abrir ou mostra o cartão do que falta. O estado vem de src/main/system/prerequisites.js.
//
// O app NÃO trava inteiro sem esses programas: entrar, criar conta, Aprovações, Meu acesso,
// Configurações e Atualizações só precisam de internet. Só o que depende da rede do Tailscale (conectar,
// laboratório, arquivos) ou do servidor VNC deste PC (ser controlado por VNC) é barrado, tela a tela.
//
// 'unknown' (a leitura falhou ou ainda não veio) nunca bloqueia: melhor deixar a pessoa tentar do que
// travar quem tem tudo instalado por um erro nosso.

export const PREREQUISITE_NAMES = ['tailscale', 'tightvnc'];

// connect, lab, files: precisam do Tailscale ligado neste PC (o app só disca endereços 100.x).
// receive: o cartão "Este PC", que recebe conexões (precisa do Tailscale e, para VNC, do TightVNC 2).
// access, account, home...: nunca bloqueadas.
const NEEDS_TAILSCALE = new Set(['connect', 'lab', 'files', 'receive']);

const TAILSCALE_GATES = {
  missing: {
    kind: 'tailscale-missing',
    title: 'Falta o Tailscale',
    message:
      'O OpenPortal conecta os PCs pela rede do Tailscale, e ele não está instalado neste computador. Sem ele não dá para conectar a outros PCs nem receber conexões.',
    actions: ['install-tailscale', 'recheck'],
  },
  stopped: {
    kind: 'tailscale-stopped',
    title: 'O Tailscale está desligado',
    message:
      'O Tailscale está instalado, mas não está ligado neste computador. Abra o Tailscale e conecte para usar esta tela.',
    actions: ['open-tailscale', 'recheck'],
  },
  'needs-login': {
    kind: 'tailscale-login',
    title: 'Entre na sua conta do Tailscale',
    message:
      'O Tailscale está instalado, mas ainda não entrou numa conta. Abra o Tailscale, entre e volte aqui.',
    actions: ['open-tailscale', 'recheck'],
  },
};

// Telas inteiras (ou seções) que não funcionam sem o Tailscale: devolve o cartão ou null.
export function gateFor({ screen, prerequisites }) {
  if (!NEEDS_TAILSCALE.has(screen)) return null;
  const state = prerequisites?.tailscale?.state;
  return TAILSCALE_GATES[state] || null;
}

// O TightVNC só importa para receber conexões VNC neste PC. Devolve um aviso (não bloqueia o cartão
// "Este PC", que ainda mostra o IP e a senha) ou null.
export function vncNoteFor({ prerequisites }) {
  const tightvnc = prerequisites?.tightvnc;
  const state = tightvnc?.state;
  if (state === 'missing') {
    const rdp = prerequisites?.windows?.rdpHosting;
    const alternative =
      rdp === true
        ? ' O seu Windows aceita RDP: ligue-o em Configurações para receber conexões sem o TightVNC.'
        : rdp === false
          ? ' O seu Windows é a edição Home, que não recebe RDP: para ser controlado por outros PCs o TightVNC é necessário.'
          : '';
    return {
      kind: 'tightvnc-missing',
      title: 'Falta o TightVNC',
      message: `Sem o TightVNC, este PC não recebe conexões por VNC.${alternative}`,
      actions: ['install-tightvnc', 'recheck'],
    };
  }
  if (state === 'unsupported') {
    return {
      kind: 'tightvnc-unsupported',
      title: 'TightVNC 4 instalado',
      message:
        'O OpenPortal configura só o TightVNC 2. Para receber conexões por VNC neste PC, desinstale o TightVNC 4 pelo Windows (Aplicativos instalados), instale o TightVNC 2 em tightvnc.com e clique em Verificar de novo.',
      actions: ['recheck'],
    };
  }
  if (state === 'stopped') {
    return {
      kind: 'tightvnc-stopped',
      title: 'O TightVNC está parado',
      message:
        'O serviço do TightVNC está parado neste PC. Inicie o serviço "TightVNC Server" no Windows e verifique de novo.',
      actions: ['recheck'],
    };
  }
  return null;
}

// Linha de cada programa para a tela "Verificação do computador".
const TAILSCALE_ROWS = {
  running: { tone: 'ok', label: 'Conectado' },
  'needs-login': { tone: 'warning', label: 'Instalado, falta entrar na conta' },
  stopped: { tone: 'warning', label: 'Instalado, mas desligado' },
  missing: { tone: 'missing', label: 'Não instalado' },
  unknown: { tone: 'unknown', label: 'Não foi possível verificar' },
};

const TIGHTVNC_ROWS = {
  running: { tone: 'ok', label: 'Instalado e rodando' },
  stopped: { tone: 'warning', label: 'Instalado, mas parado' },
  unsupported: { tone: 'warning', label: 'Versão 4 (o OpenPortal usa a 2)' },
  missing: { tone: 'missing', label: 'Não instalado' },
  unknown: { tone: 'unknown', label: 'Não foi possível verificar' },
};

export function describePrerequisites(prerequisites) {
  const tailscaleState = prerequisites?.tailscale?.state || 'unknown';
  const tightvncState = prerequisites?.tightvnc?.state || 'unknown';
  return [
    {
      name: 'tailscale',
      title: 'Tailscale',
      purpose:
        'Conecta os PCs entre si e confirma quem está conectando. Necessário para conectar a outros PCs e para ser acessado por eles.',
      required: true,
      state: tailscaleState,
      ...(TAILSCALE_ROWS[tailscaleState] || TAILSCALE_ROWS.unknown),
    },
    {
      name: 'tightvnc',
      title: 'TightVNC',
      purpose:
        'Servidor VNC deste PC. Só é necessário se outros PCs forem controlar este pelo VNC; no Windows Pro, Enterprise ou Education o RDP serve sem ele.',
      required: false,
      state: tightvncState,
      ...(TIGHTVNC_ROWS[tightvncState] || TIGHTVNC_ROWS.unknown),
    },
  ];
}

// A "Verificação do computador" aparece na primeira abertura só quando há algo a resolver.
export function needsAttention(prerequisites) {
  if (!prerequisites) return false;
  const tailscale = prerequisites.tailscale?.state;
  const tightvnc = prerequisites.tightvnc?.state;
  return (
    ['missing', 'stopped', 'needs-login'].includes(tailscale) ||
    ['missing', 'stopped', 'unsupported'].includes(tightvnc)
  );
}
