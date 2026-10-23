import { useEffect, useRef, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { formatRequestedAt } from '../../shared/lib/accounts';
import { DangerButton, GhostButton, PrimaryButton } from '../lab/LabDialog';
import { useAuth } from './AuthContext';
import { Notice } from './fields';

// Aprovações (GOALS 20): os pedidos de quem se cadastrou como professor. Aprovar dá acesso ao
// laboratório; cada decisão pede uma confirmação ali mesmo, na linha. Só professor vê esta tela, e
// o banco recusa quem não é professor de qualquer forma.
export default function ApprovalsPanel() {
  const { requests } = useAuth();
  const [confirming, setConfirming] = useState(null); // { id, approve }
  const [busyId, setBusyId] = useState('');
  const [feedback, setFeedback] = useState(null);
  const alive = useRef(true);
  const { reload } = requests;

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(reload, 0);
    return () => {
      alive.current = false;
      clearTimeout(first);
    };
  }, [reload]);

  const decide = async (request, approve) => {
    setBusyId(request.id);
    setFeedback(null);
    let result;
    try {
      result = await window.electronAPI.decideTeacherRequest({ id: request.id, approve });
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    if (!alive.current) return;
    setBusyId('');
    setConfirming(null);
    setFeedback(
      result?.ok
        ? {
            kind: 'info',
            text: approve
              ? `${request.fullName} agora é professor.`
              : `O pedido de ${request.fullName} foi recusado.`,
          }
        : { kind: 'error', text: result?.message || 'Não foi possível concluir.' },
    );
    reload();
  };

  return (
    <div className="flex-1 overflow-auto bg-canvas text-text-primary p-10">
      <div className="max-w-3xl w-full mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <UserCheck size={20} className="text-accent" />
          <h1 className="text-2xl font-light">Aprovações</h1>
        </div>
        <p className="text-sm text-text-faint mb-6">
          Pessoas que se cadastraram como professor e esperam a sua aprovação. Quem for aprovado
          passa a gerenciar os PCs e os alunos do laboratório.
        </p>

        <Notice tone={feedback?.kind === 'error' ? 'error' : 'info'}>{feedback?.text}</Notice>
        <Notice tone="error">{requests.error}</Notice>

        <div className="bg-surface rounded-xl border border-line-subtle p-5">
          {!requests.loaded && requests.loading ? (
            <div role="status" className="text-sm text-text-faint">
              Carregando...
            </div>
          ) : requests.list.length === 0 ? (
            <div className="text-sm text-text-faint">Nenhum pedido pendente.</div>
          ) : (
            <ul className="space-y-2">
              {requests.list.map((request) => {
                const asking = confirming?.id === request.id ? confirming : null;
                const busy = busyId === request.id;
                return (
                  <li
                    key={request.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-line-subtle bg-inset px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{request.fullName}</div>
                      <div className="text-[11px] text-text-faint truncate">
                        {request.email} · pediu em {formatRequestedAt(request.requestedAt)}
                      </div>
                    </div>
                    {asking ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-secondary">
                          {asking.approve ? 'Aprovar como professor?' : 'Recusar o pedido?'}
                        </span>
                        {asking.approve ? (
                          <PrimaryButton
                            disabled={busy}
                            onClick={() => decide(request, true)}
                            autoFocus
                          >
                            {busy ? 'Aprovando...' : 'Sim, aprovar'}
                          </PrimaryButton>
                        ) : (
                          <DangerButton
                            disabled={busy}
                            onClick={() => decide(request, false)}
                            autoFocus
                          >
                            {busy ? 'Recusando...' : 'Sim, recusar'}
                          </DangerButton>
                        )}
                        <GhostButton disabled={busy} onClick={() => setConfirming(null)}>
                          Cancelar
                        </GhostButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <PrimaryButton
                          disabled={Boolean(busyId)}
                          onClick={() => setConfirming({ id: request.id, approve: true })}
                        >
                          Aprovar
                        </PrimaryButton>
                        <GhostButton
                          disabled={Boolean(busyId)}
                          onClick={() => setConfirming({ id: request.id, approve: false })}
                        >
                          Recusar
                        </GhostButton>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
