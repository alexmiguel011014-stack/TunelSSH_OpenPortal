import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';

const sectionTitle = 'text-xs font-semibold mb-3 uppercase tracking-wide text-text-muted';
const iconButton =
  'p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors';

// Cartão "Este PC" da tela inicial, estilo TeamViewer/AnyDesk: o IP Tailscale
// deste PC e a senha de acesso da sessão, para passar a quem vai conectar. A
// senha vive no processo principal; aqui ela só é exibida.
export default function LocalAccessCard() {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState('');
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState('');

  useEffect(() => {
    let alive = true;
    window.electronAPI
      ?.getLocalAccess?.()
      .then((next) => {
        if (alive) setInfo(next);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI?.onLocalAccessChanged?.(setInfo);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const copy = async (key, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch {}
  };

  const rotate = async () => {
    const next = await window.electronAPI?.rotateSessionPassword?.();
    if (next) setInfo(next);
  };

  // As duas ações pedem UAC e devolvem o estado atualizado mesmo em falha
  // parcial (ex.: senha aplicada, mas a 5900 ainda aberta na rede).
  const runHostVncAction = async (action, fallbackError) => {
    setSettingUp(true);
    setSetupError('');
    try {
      const res = await action();
      if (res && 'hostVncConfigured' in res) setInfo(res);
      if (!res?.success) setSetupError(res?.error || fallbackError);
    } finally {
      setSettingUp(false);
    }
  };

  const setupHostVnc = () =>
    runHostVncAction(
      () => window.electronAPI?.setupHostVnc?.(),
      'Não foi possível configurar o TightVNC deste PC.',
    );

  const allowDirectVnc = () =>
    runHostVncAction(
      () => window.electronAPI?.allowDirectVnc?.(),
      'Não foi possível liberar o VNC direto.',
    );

  let setupLabel = info?.hostVncConfigured ? 'Proteger TightVNC' : 'Configurar TightVNC';
  if (settingUp) setupLabel = 'Configurando...';

  const field = (key, label, value, placeholder, extra = null) => (
    <div className="bg-inset border border-line-subtle rounded-lg px-3 py-2.5">
      <div className="text-[11px] text-text-faint mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <span className="flex-1 font-mono text-lg tracking-wider text-text-primary truncate">
          {value || <span className="text-sm text-text-faint tracking-normal">{placeholder}</span>}
        </span>
        {value && (
          <button
            type="button"
            onClick={() => copy(key, value)}
            title="Copiar"
            aria-label={`Copiar ${label}`}
            className={iconButton}
          >
            {copied === key ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        {extra}
      </div>
    </div>
  );

  return (
    <div className="bg-surface rounded-xl border border-line-subtle p-5 mb-4">
      <h2 className={sectionTitle}>Este PC</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {field('ip', 'IP Tailscale', info?.ip, info ? 'Tailscale desconectado' : '—')}
        {field(
          'password',
          'Senha de acesso',
          info?.sessionPassword,
          '—',
          <button
            type="button"
            onClick={rotate}
            title="Gerar outra senha"
            aria-label="Gerar outra senha de acesso"
            className={iconButton}
          >
            <RefreshCw size={14} />
          </button>,
        )}
      </div>
      <p className="text-[11px] text-text-faint mt-2">
        Quem tiver este IP e a senha entra sem você clicar em Aceitar. A senha muda depois de cada
        acesso e sempre que o app abre.
      </p>
      {info && !info.hostVncLocalOnly && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-text-secondary">
          <span className="flex-1">
            {info.hostVncConfigured
              ? 'O TightVNC deste PC ainda aceita conexões diretas pela rede, sem passar pela aprovação. Proteja uma vez: ele passa a aceitar só conexões feitas pelo OpenPortal (o Windows pede permissão de administrador).'
              : 'O TightVNC deste PC ainda não foi configurado pelo app: quem conectar precisaria digitar a senha dele, e ele aceita conexões sem passar pela aprovação. Configure uma vez; o Windows pede permissão de administrador.'}
          </span>
          <button
            type="button"
            onClick={setupHostVnc}
            disabled={settingUp}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-60"
          >
            {setupLabel}
          </button>
        </div>
      )}
      {info?.hostVncLocalOnly && (
        <div className="mt-3 flex items-center gap-3 text-[11px] text-text-faint">
          <span className="flex-1">
            TightVNC protegido: só aceita conexões feitas pelo OpenPortal, depois da aprovação.
          </span>
          <button
            type="button"
            onClick={allowDirectVnc}
            disabled={settingUp}
            className="text-text-muted hover:text-text-primary underline underline-offset-2 disabled:opacity-60"
          >
            {settingUp ? 'Aguarde...' : 'Liberar VNC direto'}
          </button>
        </div>
      )}
      {setupError && <p className="mt-2 text-xs text-danger">{setupError}</p>}
    </div>
  );
}
