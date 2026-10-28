import { Download, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import { gateFor } from '../../shared/lib/requirements';
import { usePrereqs } from './PrereqsContext';

const primaryButton =
  'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-60';
const secondaryButton =
  'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs border border-line text-text-secondary hover:border-text-faint transition-colors whitespace-nowrap disabled:opacity-60';

// Os botões de um cartão ("install-tailscale", "open-tailscale", "recheck"...), com o que cada um
// faz. Fica numa peça só para o cartão de tela inteira, o aviso pequeno e a tela de verificação.
export function RequirementActions({ actions }) {
  const { busy, refresh, install, openTailscale } = usePrereqs();
  const installing = Boolean(busy);
  const buttons = {
    'install-tailscale': (
      <button
        key="install-tailscale"
        type="button"
        className={primaryButton}
        disabled={installing}
        onClick={() => install('tailscale')}
      >
        <Download size={13} />
        {busy === 'tailscale' ? 'Instalando o Tailscale...' : 'Instalar o Tailscale'}
      </button>
    ),
    'install-tightvnc': (
      <button
        key="install-tightvnc"
        type="button"
        className={primaryButton}
        disabled={installing}
        onClick={() => install('tightvnc')}
      >
        <Download size={13} />
        {busy === 'tightvnc' ? 'Instalando o TightVNC...' : 'Instalar o TightVNC'}
      </button>
    ),
    'open-tailscale': (
      <button
        key="open-tailscale"
        type="button"
        className={primaryButton}
        disabled={installing}
        onClick={openTailscale}
      >
        <ExternalLink size={13} />
        Abrir o Tailscale
      </button>
    ),
    recheck: (
      <button
        key="recheck"
        type="button"
        className={secondaryButton}
        disabled={installing}
        onClick={() => refresh({ force: true })}
      >
        <RefreshCw size={13} />
        Verificar de novo
      </button>
    ),
  };
  return <div className="flex flex-wrap items-center gap-2">{actions.map((a) => buttons[a])}</div>;
}

// De qual programa é o cartão: kind começa com "tailscale-" ou "tightvnc-" (requirements.js).
const programOf = (gate) => (String(gate.kind).startsWith('tightvnc') ? 'tightvnc' : 'tailscale');

// O andamento e o resultado da instalação de UM programa: cada cartão só mostra o do seu programa
// (o aviso do Tailscale não aparece embaixo do cartão do TightVNC).
function InstallNotice({ program }) {
  const { busy, notice } = usePrereqs();
  if (busy) {
    if (busy !== program) return null;
    return (
      <p role="status" className="mt-3 text-xs text-text-secondary">
        Baixando e instalando. O Windows pode pedir permissão de administrador; aceite para
        continuar.
      </p>
    );
  }
  if (!notice || notice.name !== program) return null;
  return (
    <p
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={`mt-3 text-xs ${notice.kind === 'error' ? 'text-danger' : 'text-text-secondary'}`}
    >
      {notice.text}
    </p>
  );
}

// O cartão que ocupa o lugar de uma tela que não funciona sem o programa (variant "card"), ou o aviso
// compacto dentro de uma tela que continua útil, como o cartão "Este PC" (variant "notice").
export function RequirementGate({ gate, variant = 'card' }) {
  if (!gate) return null;
  if (variant === 'notice') {
    return (
      <div
        role="note"
        className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-text-secondary"
      >
        <div className="font-medium text-text-primary">{gate.title}</div>
        <p className="mt-0.5">{gate.message}</p>
        <div className="mt-2">
          <RequirementActions actions={gate.actions} />
        </div>
        <InstallNotice program={programOf(gate)} />
      </div>
    );
  }
  return (
    <div className="flex-1 flex items-center justify-center bg-canvas text-text-primary p-10 overflow-auto">
      <div
        role="region"
        aria-label={gate.title}
        className="max-w-md w-full bg-surface rounded-xl border border-line-subtle p-6"
      >
        <ShieldAlert size={28} className="text-warning mb-3" />
        <h2 className="text-lg font-semibold mb-1">{gate.title}</h2>
        <p className="text-sm text-text-secondary mb-4">{gate.message}</p>
        <RequirementActions actions={gate.actions} />
        <InstallNotice program={programOf(gate)} />
        <p className="mt-4 text-[11px] text-text-faint">
          O resto do OpenPortal continua funcionando: entrar na conta, Meu acesso e Configurações
          não dependem disso.
        </p>
      </div>
    </div>
  );
}

// Envolve uma tela que depende do Tailscale: mostra o cartão no lugar dela quando ele falta.
export default function Gated({ screen, children }) {
  const { prerequisites } = usePrereqs();
  const gate = gateFor({ screen, prerequisites });
  return gate ? <RequirementGate gate={gate} /> : children;
}
