import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, MonitorPlay } from 'lucide-react';
import { CLIPBOARD_CLEAR_SECONDS, describeMyAccess } from '../../shared/lib/access';
import { Notice } from '../auth/fields';
import { PrimaryButton, GhostButton } from '../lab/LabDialog';

// "Meu acesso" (GOALS 21): a tela inicial do aluno. Mostra o PC do laboratório que o professor
// liberou, com endereço, usuário, senha e horários, e abre a Área de Trabalho Remota do Windows.
// A senha vive só em memória nesta tela e some quando o acesso termina ou é trocado; "Copiar senha"
// passa pelo processo principal, que limpa a área de transferência depois de 1 minuto.

function Row({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <dt className="w-24 shrink-0 text-[11px] text-text-faint uppercase tracking-wide">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-text-primary break-all">{children}</dd>
    </div>
  );
}

// Cada acesso tem o seu cartão (`key` = id do acesso): ao trocar de aluno a senha volta a ficar oculta.
function AccessCard({ access, now }) {
  const card = describeMyAccess(access, now);
  const [shown, setShown] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState('');
  if (!card) return null;

  const run = async (name, action, doneText) => {
    setBusy(name);
    setFeedback(null);
    try {
      const result = await action();
      setFeedback(
        result?.ok
          ? { kind: 'info', text: doneText }
          : { kind: 'error', text: result?.message || 'Não foi possível concluir.' },
      );
    } catch (err) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <section
      aria-label="Acesso liberado"
      className="bg-surface rounded-xl border border-line-subtle p-5"
    >
      <h2 className="text-base font-semibold mb-1">{card.pcName}</h2>
      {card.startLine && <p className="text-xs text-warning mb-1">{card.startLine}</p>}
      <p className="text-xs text-text-secondary mb-3">{card.endLine}</p>

      <dl className="mb-4">
        <Row label="Endereço">
          <span className="font-mono">{card.address}</span>
        </Row>
        <Row label="Usuário">
          <span className="font-mono">{card.userName}</span>
        </Row>
        <Row label="Senha">
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono" data-testid="password">
              {shown ? access.password : '••••••••••'}
            </span>
            <button
              type="button"
              onClick={() => setShown((current) => !current)}
              aria-pressed={shown}
              className="text-xs text-accent hover:underline bg-transparent border-none p-0"
            >
              {shown ? 'Ocultar' : 'Mostrar'}
            </button>
          </span>
        </Row>
      </dl>

      <div className="flex flex-wrap gap-2 mb-3">
        <PrimaryButton
          disabled={busy !== ''}
          onClick={() =>
            run(
              'rdp',
              () => window.electronAPI.openMyAccessRdp(),
              'A Área de Trabalho Remota abriu: cole a senha quando o Windows pedir.',
            )
          }
        >
          <span className="inline-flex items-center gap-1.5">
            <MonitorPlay size={15} />
            Abrir Área de Trabalho Remota
          </span>
        </PrimaryButton>
        <GhostButton
          disabled={busy !== ''}
          onClick={() =>
            run(
              'copy',
              () => window.electronAPI.copyMyAccessPassword(),
              `Senha copiada. Ela sai da área de transferência em ${CLIPBOARD_CLEAR_SECONDS} segundos.`,
            )
          }
        >
          <span className="inline-flex items-center gap-1.5">
            <Copy size={14} />
            Copiar senha
          </span>
        </GhostButton>
      </div>
      <Notice tone={feedback?.kind === 'error' ? 'error' : 'info'}>{feedback?.text}</Notice>

      <div className="space-y-1 text-[11px] text-text-faint">
        <p>{card.notice}</p>
        {card.tailscaleHint && <p>{card.tailscaleHint}</p>}
        <p>{card.endHint}</p>
      </div>
    </section>
  );
}

export default function MyAccessPanel() {
  const [access, setAccess] = useState(undefined); // undefined: ainda lendo
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.getMyAccess();
      if (result?.ok) {
        setAccess(result.access);
        setError('');
      } else {
        setError(result?.message || 'Não consegui consultar o acesso agora.');
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Lê ao abrir, a cada mudança que o processo principal avisar e ao voltar para a janela; o relógio
  // faz o cartão sumir no horário de término sem esperar a releitura.
  useEffect(() => {
    const api = window.electronAPI;
    const first = setTimeout(load, 0);
    const unsubscribe = api.onMyAccessChanged?.((next) => {
      setAccess(next);
      setError('');
    });
    const clock = setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener('focus', load);
    return () => {
      clearTimeout(first);
      clearInterval(clock);
      window.removeEventListener('focus', load);
      unsubscribe?.();
    };
  }, [load]);

  const active = describeMyAccess(access, now) !== null;

  return (
    <div className="flex-1 overflow-auto bg-canvas text-text-primary p-10">
      <div className="max-w-3xl w-full mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound size={20} className="text-accent" />
          <h1 className="text-2xl font-light">Meu acesso</h1>
        </div>
        <p className="text-sm text-text-faint mb-6">
          O PC do laboratório que o professor liberou para você aparece aqui.
        </p>

        {error && !active && <Notice tone="error">{error}</Notice>}
        {error && active && (
          <Notice tone="warning">
            Não consegui atualizar agora ({error}). Mostrando o último acesso recebido.
          </Notice>
        )}

        {active ? (
          <AccessCard key={access.id} access={access} now={now} />
        ) : access === undefined && !error ? (
          <div role="status" className="text-sm text-text-faint">
            Consultando...
          </div>
        ) : (
          <div className="bg-surface rounded-xl border border-line-subtle p-5 text-sm text-text-faint">
            Nenhum acesso liberado agora. Peça ao professor.
          </div>
        )}
      </div>
    </div>
  );
}
