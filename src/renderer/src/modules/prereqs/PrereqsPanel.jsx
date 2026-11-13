import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, CircleHelp, CircleX } from 'lucide-react';
import { describePrerequisites, needsAttention } from '../../shared/lib/requirements';
import { usePrereqs } from './PrereqsContext';
import { RequirementActions } from './RequirementGate';

const REVIEWED_KEY = 'openportal-prereqs-reviewed';

function wasReviewed() {
  try {
    return localStorage.getItem(REVIEWED_KEY) === '1';
  } catch {
    return false;
  }
}

function markReviewed() {
  try {
    localStorage.setItem(REVIEWED_KEY, '1');
  } catch {}
}

const TONE = {
  ok: { icon: CheckCircle2, className: 'text-success' },
  warning: { icon: CircleAlert, className: 'text-warning' },
  missing: { icon: CircleX, className: 'text-danger' },
  unknown: { icon: CircleHelp, className: 'text-text-faint' },
};

// Que botão cada linha oferece: instalar o que falta, abrir o Tailscale para entrar na conta.
function actionsFor(row) {
  if (row.name === 'tailscale') {
    if (row.state === 'missing') return ['install-tailscale'];
    if (row.state === 'stopped' || row.state === 'needs-login') return ['open-tailscale'];
  }
  if (row.name === 'tightvnc' && row.state === 'missing') return ['install-tightvnc'];
  return [];
}

// A lista dos dois programas com o estado de cada um e o botão que resolve. Serve para a tela de
// primeira abertura e para o cartão "Programas necessários" de Configurações.
export default function PrereqsPanel() {
  const { prerequisites, loaded, busy, notice } = usePrereqs();
  const rows = describePrerequisites(prerequisites);
  const edition = prerequisites?.windows?.edition;

  return (
    <div>
      <ul className="space-y-3">
        {rows.map((row) => {
          const tone = TONE[row.tone] || TONE.unknown;
          const Icon = tone.icon;
          const actions = actionsFor(row);
          return (
            <li
              key={row.name}
              className="rounded-lg border border-line-subtle bg-inset px-4 py-3"
              aria-label={row.title}
            >
              <div className="flex items-start gap-3">
                <Icon
                  size={18}
                  className={`${tone.className} mt-0.5 shrink-0`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-text-primary">{row.title}</span>
                    <span className={`text-xs ${tone.className}`}>
                      {loaded || prerequisites ? row.label : 'Verificando...'}
                    </span>
                    {!row.required && <span className="text-[11px] text-text-faint">opcional</span>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-faint">{row.purpose}</p>
                  {actions.length > 0 && (
                    <div className="mt-2">
                      <RequirementActions actions={actions} />
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {busy && (
        <p role="status" className="mt-3 text-xs text-text-secondary">
          Baixando e instalando. O Windows pode pedir permissão de administrador; aceite para
          continuar.
        </p>
      )}
      {notice && !busy && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 text-xs ${notice.kind === 'error' ? 'text-danger' : 'text-text-secondary'}`}
        >
          {notice.text}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <RequirementActions actions={['recheck']} />
        {edition && (
          <span className="text-[11px] text-text-faint">
            Windows: {edition}
            {prerequisites?.windows?.rdpHosting === false ? ' (não recebe conexões RDP)' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

// A "Verificação do computador" da primeira abertura: aparece uma vez por PC, só se algo falta, em cima
// do conteúdo. "Continuar" (ou "Continuar sem instalar") a dispensa; o cartão de cada tela segue
// avisando o que não funciona. Quem já tem tudo nunca vê esta tela.
export function FirstRunReview() {
  const { prerequisites, loaded } = usePrereqs();
  const [dismissed, setDismissed] = useState(false);
  const attention = needsAttention(prerequisites);

  useEffect(() => {
    // Tudo em ordem na primeira leitura: não há o que revisar, nem depois (só grava o aviso).
    if (loaded && prerequisites && !attention) markReviewed();
  }, [loaded, prerequisites, attention]);

  if (dismissed || !attention || wasReviewed()) return null;

  const done = () => {
    markReviewed();
    setDismissed(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Verificação do computador"
      className="absolute inset-0 z-40 flex items-center justify-center bg-canvas p-6 overflow-auto"
    >
      <div className="max-w-xl w-full bg-surface rounded-xl border border-line-subtle p-6">
        <h2 className="text-lg font-semibold text-text-primary">Verificação do computador</h2>
        <p className="mt-1 mb-4 text-sm text-text-secondary">
          O OpenPortal conecta os PCs pela rede do Tailscale e, para receber conexões por VNC, usa o
          TightVNC. Veja o que este computador já tem.
        </p>
        <PrereqsPanel />
        <div className="mt-5 flex items-center justify-end gap-3 border-t border-line-subtle pt-4">
          <span className="mr-auto text-[11px] text-text-faint">
            Sem instalar, as telas que dependem deles mostram o que falta.
          </span>
          <button
            type="button"
            onClick={done}
            className="px-4 py-2 rounded-lg text-sm border border-line text-text-secondary hover:border-text-faint transition-colors whitespace-nowrap"
          >
            Continuar sem instalar
          </button>
        </div>
      </div>
    </div>
  );
}
