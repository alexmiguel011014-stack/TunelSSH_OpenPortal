import { useContext, useEffect, useState } from 'react';
import { ArrowLeft, Check, XCircle, AlertTriangle, Copy } from 'lucide-react';
import { MachineContext } from '../../App';

const MAX_PORT = 65535;

function isValidHost(host) {
  const h = (host || '').trim();
  if (!h) return false;
  if (/^[A-Za-z0-9.-]+$/.test(h)) return true;
  return false;
}

function isValidLogin(login) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((login || '').trim());
}

const DEFAULT_TELEGRAM = { enabled: false, token: '', chatId: '' };

export default function ConfigPanel() {
  const { machines, saveMachines, setShowConfig, maxMachines, addLog } = useContext(MachineContext);

  const [draft, setDraft] = useState(() => machines.map((m) => ({ ...m })));
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState({});
  const [testing, setTesting] = useState({});
  const [testResults, setTestResults] = useState({});
  const [localIp, setLocalIp] = useState(null); // null = carregando, '' = não achou

  const [allowedUsers, setAllowedUsers] = useState([]);
  const [newAllowedUser, setNewAllowedUser] = useState('');
  const [allowedUsersSaved, setAllowedUsersSaved] = useState(false);
  const [allowedUsersError, setAllowedUsersError] = useState('');

  // GOALS 4: para quem ESTA máquina empurra o resumo de cada sessão (push
  // best-effort, ver docs/ARQUITETURA_CONEXAO.md). Independente da lista de
  // auto-aprovação acima — uma coisa é quem pode entrar, outra é pra quem eu
  // aviso que entrou.
  const [reportTo, setReportTo] = useState([]);
  const [newReportTo, setNewReportTo] = useState('');
  const [reportToSaved, setReportToSaved] = useState(false);
  const [reportToError, setReportToError] = useState('');

  const [telegram, setTelegram] = useState(DEFAULT_TELEGRAM);
  const [telegramSaved, setTelegramSaved] = useState(false);

  useEffect(() => {
    window.electronAPI
      ?.getLocalIp?.()
      .then((res) => setLocalIp(res?.ip || ''))
      .catch(() => setLocalIp(''));
  }, []);

  useEffect(() => {
    window.electronAPI
      ?.getConfig?.()
      .then((cfg) => {
        setAllowedUsers(Array.isArray(cfg?.allowedUsers) ? cfg.allowedUsers : []);
        setReportTo(Array.isArray(cfg?.reportTo) ? cfg.reportTo : []);
        setTelegram({ ...DEFAULT_TELEGRAM, ...(cfg?.telegram || {}) });
      })
      .catch(() => {
        setAllowedUsers([]);
        setReportTo([]);
        setTelegram(DEFAULT_TELEGRAM);
      });
  }, []);

  const copyLocalIp = () => {
    if (localIp) navigator.clipboard?.writeText(localIp);
  };

  const saveAllowedUsers = (next) => {
    setAllowedUsers(next);
    window.electronAPI?.saveConfig({ allowedUsers: next });
    setAllowedUsersSaved(true);
    setTimeout(() => setAllowedUsersSaved(false), 2000);
  };

  const handleAddAllowedUser = () => {
    const login = newAllowedUser.trim();
    if (!isValidLogin(login)) {
      setAllowedUsersError('Informe um e-mail de login Tailscale válido');
      return;
    }
    if (allowedUsers.includes(login)) {
      setAllowedUsersError('Esse e-mail já está na lista');
      return;
    }
    setAllowedUsersError('');
    setNewAllowedUser('');
    saveAllowedUsers([...allowedUsers, login]);
    if (addLog) addLog(`Adicionado à lista de auto-aprovação: ${login}`, 'info');
  };

  const handleRemoveAllowedUser = (login) => {
    saveAllowedUsers(allowedUsers.filter((u) => u !== login));
    if (addLog) addLog(`Removido da lista de auto-aprovação: ${login}`, 'info');
  };

  const saveReportTo = (next) => {
    setReportTo(next);
    window.electronAPI?.saveConfig({ reportTo: next });
    setReportToSaved(true);
    setTimeout(() => setReportToSaved(false), 2000);
  };

  const handleAddReportTo = () => {
    const login = newReportTo.trim();
    if (!isValidLogin(login)) {
      setReportToError('Informe um e-mail de login Tailscale válido');
      return;
    }
    if (reportTo.includes(login)) {
      setReportToError('Esse e-mail já está na lista');
      return;
    }
    setReportToError('');
    setNewReportTo('');
    saveReportTo([...reportTo, login]);
    if (addLog) addLog(`Adicionado ao envio de atividade: ${login}`, 'info');
  };

  const handleRemoveReportTo = (login) => {
    saveReportTo(reportTo.filter((u) => u !== login));
    if (addLog) addLog(`Removido do envio de atividade: ${login}`, 'info');
  };

  const saveTelegram = (next) => {
    setTelegram(next);
    window.electronAPI?.saveConfig({ telegram: next });
    setTelegramSaved(true);
    setTimeout(() => setTelegramSaved(false), 2000);
  };

  const handleToggleTelegram = () => {
    saveTelegram({ ...telegram, enabled: !telegram.enabled });
  };

  const handleTest = async (index, machine) => {
    const host = (machine.host || '').trim();
    if (!host) {
      if (addLog) addLog('Informe o IP antes de testar', 'warn');
      return;
    }
    setTesting((prev) => ({ ...prev, [index]: true }));
    setTestResults((prev) => ({ ...prev, [index]: null }));
    try {
      const res = await window.electronAPI.testConnection(host, machine.port || 5900);
      setTestResults((prev) => ({ ...prev, [index]: res }));
      if (addLog) {
        if (res.ok) {
          addLog(`Teste OK: ${host}:${machine.port} acessível em ${res.ms}ms`, 'info');
        } else {
          const hint = res.error?.includes('ECONNREFUSED')
            ? ' (VNC não está rodando?)'
            : res.error?.includes('ENOTFOUND')
              ? ' (IP não resolvido ou offline)'
              : res.error?.includes('ETIMEDOUT')
                ? ' (Tailscale não alcança?)'
                : '';
          addLog(`Teste falhou: ${host}:${machine.port} (${res.error})${hint}`, 'warn');
        }
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [index]: { ok: false, error: err.message },
      }));
      if (addLog) addLog(`✗ Erro no teste: ${err.message}`, 'error');
    } finally {
      setTesting((prev) => ({ ...prev, [index]: false }));
    }
  };

  const validate = (list) => {
    const errs = {};
    list.forEach((m, i) => {
      const errorsFor = [];
      const name = (m.name || '').trim();
      if (!name) errorsFor.push('Informe um nome');
      if (m.host && !isValidHost(m.host)) errorsFor.push('IP/host inválido');
      if (m.port < 1 || m.port > MAX_PORT) errorsFor.push(`Porta entre 1 e ${MAX_PORT}`);
      if (errorsFor.length) errs[i] = errorsFor;
    });
    return errs;
  };

  const updateField = (index, field, value) => {
    setDraft((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setSaved(false);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleSave = () => {
    const errs = validate(draft);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      if (addLog) addLog('Configuração não salva: corrija os campos destacados', 'warn');
      return;
    }
    saveMachines(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAddLocal = () => {
    if (draft.length >= maxMachines) {
      if (addLog) addLog(`Máximo de ${maxMachines} PC(s) atingido`, 'warn');
      return;
    }
    const newMachine = {
      id: 'tmp-' + Date.now(),
      name: `PC ${draft.length + 1}`,
      host: '',
      port: 5900,
    };
    setDraft((prev) => [...prev, newMachine]);
  };

  const handleRemoveLocal = (index) => {
    if (draft.length <= 1) return;
    setDraft((prev) => prev.filter((_, i) => i !== index));
    setErrors((prev) => {
      const next = {};
      Object.keys(prev).forEach((k) => {
        const ki = parseInt(k, 10);
        next[ki > index ? ki - 1 : ki] = prev[k];
      });
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-semibold text-text-primary">Configurações</h2>
            <p className="text-sm text-text-muted mt-1">
              Configure os PCs remotos ({draft.length}/{maxMachines})
            </p>
          </div>
          <button
            onClick={() => setShowConfig(false)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            <ArrowLeft size={16} /> Voltar
          </button>
        </div>

        <div className="mb-6 p-4 bg-accent/10 rounded-xl border border-accent/30">
          <p className="text-xs text-text-faint mb-1">
            Este é o IP Tailscale <strong>deste</strong> PC — passe ele para quem for conectar aqui.
            Para conectar <strong>neste app</strong> em outro PC, use o IP Tailscale do PC remoto
            (visto lá, não aqui).
          </p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 px-3 py-2 bg-inset rounded-lg text-sm font-mono text-text-primary border border-line">
              {localIp === null
                ? 'Detectando...'
                : localIp || 'Não encontrado — Tailscale está instalado e conectado?'}
            </code>
            {localIp && (
              <button
                onClick={copyLocalIp}
                title="Copiar IP"
                className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-line text-text-secondary hover:border-accent hover:text-accent transition-colors"
              >
                <Copy size={14} /> Copiar
              </button>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {draft.map((machine, index) => (
            <div
              key={machine.id}
              className={`bg-surface rounded-xl p-5 border relative ${errors[index] ? 'border-danger/60' : 'border-line'}`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-text-secondary">
                  {machine.name || `PC ${index + 1}`}
                </h3>
                {draft.length > 1 && (
                  <button
                    onClick={() => handleRemoveLocal(index)}
                    className="text-xs text-danger hover:opacity-80 transition-opacity bg-transparent border border-danger/40 rounded px-2 py-1"
                  >
                    Remover
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-text-faint mb-1">Nome</label>
                  <input
                    type="text"
                    value={machine.name}
                    onChange={(e) => updateField(index, 'name', e.target.value)}
                    className={`w-full bg-inset border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent transition-colors ${errors[index] && !machine.name.trim() ? 'border-danger' : 'border-line'}`}
                    placeholder="Ex.: PC da Sala"
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-faint mb-1">IP Tailscale</label>
                  <input
                    type="text"
                    value={machine.host}
                    onChange={(e) => updateField(index, 'host', e.target.value)}
                    className={`w-full bg-inset border rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors ${errors[index] && machine.host && !isValidHost(machine.host) ? 'border-danger' : 'border-line'}`}
                    placeholder="100.x.x.x"
                  />
                  {testResults[index] && (
                    <div
                      className={`flex items-center gap-1 text-xs mt-1 ${testResults[index].ok ? 'text-success' : 'text-danger'}`}
                    >
                      {testResults[index].ok ? <Check size={12} /> : <XCircle size={12} />}
                      {testResults[index].ok
                        ? `Acessível em ${testResults[index].ms}ms`
                        : `Falhou: ${testResults[index].error}`}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleTest(index, machine)}
                    disabled={testing[index] || !(machine.host || '').trim()}
                    className={`mt-2 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      testing[index]
                        ? 'border-line text-text-muted cursor-wait'
                        : 'border-line text-text-secondary hover:border-accent hover:text-accent'
                    }`}
                  >
                    {testing[index] ? 'Testando...' : 'Testar conexão'}
                  </button>
                </div>
                <div>
                  <label className="block text-xs text-text-faint mb-1">Porta VNC</label>
                  <input
                    type="number"
                    min="1"
                    max={MAX_PORT}
                    value={machine.port}
                    onChange={(e) => updateField(index, 'port', parseInt(e.target.value) || 5900)}
                    className={`w-full bg-inset border rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors ${errors[index] && (machine.port < 1 || machine.port > MAX_PORT) ? 'border-danger' : 'border-line'}`}
                    placeholder="5900"
                  />
                  {[18900, 18901, 18902, 18903].includes(Number(machine.port)) && (
                    <p className="flex items-center gap-1 text-xs text-warning mt-1">
                      <AlertTriangle size={12} /> Essa é uma porta interna do OpenPortal, não do
                      VNC. Use 5900 (padrão do TightVNC).
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-4">
                <label className="block text-xs text-text-faint mb-1">Senha VNC (opcional)</label>
                <input
                  type="password"
                  value={machine.password || ''}
                  onChange={(e) => updateField(index, 'password', e.target.value)}
                  className="w-full bg-inset border border-line rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
                  placeholder="Deixe em branco se não tiver senha"
                />
                <p className="text-xs text-text-faint mt-1">
                  Se o VNC tiver senha, configure aqui. Será usada como fallback se a conexão for
                  recusada.
                </p>
              </div>
              {errors[index] && (
                <ul className="mt-3 space-y-1">
                  {errors[index].map((err) => (
                    <li key={err} className="text-xs text-danger">
                      • {err}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {draft.length < maxMachines && (
          <button
            onClick={handleAddLocal}
            className="w-full mt-4 p-3 rounded-xl border-2 border-dashed border-line text-text-muted text-sm hover:border-text-faint hover:text-text-secondary transition-colors bg-transparent cursor-pointer"
          >
            + Adicionar PC
          </button>
        )}

        <div className="mt-8 flex items-center gap-4">
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-6 py-2.5 bg-accent hover:bg-accent-strong text-white rounded-lg text-sm font-medium transition-colors"
          >
            {saved && <Check size={16} />} {saved ? 'Salvo' : 'Salvar configuração'}
          </button>
          {saved && <span className="text-sm text-success">Configuração salva</span>}
          {!saved && Object.keys(errors).length > 0 && (
            <span className="text-sm text-danger">
              Corrija os campos destacados antes de salvar
            </span>
          )}
        </div>

        <div className="mt-10 pt-8 border-t border-line">
          <h3 className="text-sm font-medium text-text-secondary mb-1">
            Auto-aprovação de conexões
          </h3>
          <p className="text-xs text-text-faint mb-4">
            Logins Tailscale (e-mail) que se conectam a <strong>este</strong> PC sem precisar do
            diálogo Aceitar/Rejeitar. Quem não estiver nesta lista continua vendo o diálogo manual
            normalmente.
          </p>

          {allowedUsers.length > 0 && (
            <ul className="space-y-2 mb-3">
              {allowedUsers.map((login) => (
                <li
                  key={login}
                  className="flex items-center justify-between bg-surface rounded-lg px-3 py-2 border border-line"
                >
                  <span className="text-sm text-text-primary font-mono">{login}</span>
                  <button
                    onClick={() => handleRemoveAllowedUser(login)}
                    className="text-xs text-danger hover:opacity-80 transition-opacity bg-transparent border border-danger/40 rounded px-2 py-1"
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newAllowedUser}
              onChange={(e) => {
                setNewAllowedUser(e.target.value);
                setAllowedUsersError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddAllowedUser()}
              className="flex-1 bg-inset border border-line rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
              placeholder="usuario@exemplo.com"
            />
            <button
              onClick={handleAddAllowedUser}
              className="px-4 py-2 text-sm rounded-lg border border-line text-text-secondary hover:border-accent hover:text-accent transition-colors"
            >
              Adicionar
            </button>
          </div>
          {allowedUsersError && <p className="text-xs text-danger mt-2">{allowedUsersError}</p>}
          {allowedUsersSaved && (
            <p className="text-xs text-success mt-2">Lista de auto-aprovação salva</p>
          )}
        </div>

        <div className="mt-10 pt-8 border-t border-line">
          <h3 className="text-sm font-medium text-text-secondary mb-1">Reportar atividade para</h3>
          <p className="text-xs text-text-faint mb-4">
            Logins Tailscale (e-mail) que recebem um resumo (identidade, duração, arquivos
            transferidos) toda vez que uma sessão nesta máquina termina — aparece no painel
            &quot;Atividade&quot; de quem estiver na lista, em tempo real. Envio best-effort: se a
            pessoa estiver offline, o aviso é só descartado (a sessão em si não é afetada).
          </p>

          {reportTo.length > 0 && (
            <ul className="space-y-2 mb-3">
              {reportTo.map((login) => (
                <li
                  key={login}
                  className="flex items-center justify-between bg-surface rounded-lg px-3 py-2 border border-line"
                >
                  <span className="text-sm text-text-primary font-mono">{login}</span>
                  <button
                    onClick={() => handleRemoveReportTo(login)}
                    className="text-xs text-danger hover:opacity-80 transition-opacity bg-transparent border border-danger/40 rounded px-2 py-1"
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newReportTo}
              onChange={(e) => {
                setNewReportTo(e.target.value);
                setReportToError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddReportTo()}
              className="flex-1 bg-inset border border-line rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
              placeholder="professor@exemplo.com"
            />
            <button
              onClick={handleAddReportTo}
              className="px-4 py-2 text-sm rounded-lg border border-line text-text-secondary hover:border-accent hover:text-accent transition-colors"
            >
              Adicionar
            </button>
          </div>
          {reportToError && <p className="text-xs text-danger mt-2">{reportToError}</p>}
          {reportToSaved && <p className="text-xs text-success mt-2">Lista de envio salva</p>}
        </div>

        <div className="mt-10 pt-8 border-t border-line">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-text-secondary">
              Alertas do Telegram (opcional)
            </h3>
            <button
              onClick={handleToggleTelegram}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                telegram.enabled
                  ? 'border-success/50 text-success bg-success/10'
                  : 'border-line text-text-muted hover:border-text-faint'
              }`}
            >
              {telegram.enabled ? 'Ativado' : 'Desativado'}
            </button>
          </div>
          <p className="text-xs text-text-faint mb-4">
            Envia o mesmo resumo de &quot;Reportar atividade para&quot; também como mensagem no
            Telegram — um alerta a mais, não o único lugar onde a atividade aparece. Requer
            <code className="mx-1 px-1 py-0.5 bg-inset rounded text-[11px]">
              npm install telegraf
            </code>
            no app (ver <code className="text-[11px]">docs/TELEGRAM_SETUP.md</code>) e um bot criado
            com o @BotFather.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-faint mb-1">Token do bot</label>
              <input
                type="password"
                value={telegram.token}
                onChange={(e) => setTelegram((prev) => ({ ...prev, token: e.target.value }))}
                className="w-full bg-inset border border-line rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
                placeholder="123456:ABC-DEF..."
              />
            </div>
            <div>
              <label className="block text-xs text-text-faint mb-1">Chat ID de destino</label>
              <input
                type="text"
                value={telegram.chatId}
                onChange={(e) => setTelegram((prev) => ({ ...prev, chatId: e.target.value }))}
                className="w-full bg-inset border border-line rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition-colors"
                placeholder="123456789"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => saveTelegram(telegram)}
              className="px-4 py-2 text-sm rounded-lg border border-line text-text-secondary hover:border-accent hover:text-accent transition-colors"
            >
              Salvar Telegram
            </button>
            {telegramSaved && <span className="text-xs text-success">Configuração salva</span>}
          </div>
        </div>

        <div className="mt-6 p-4 bg-surface/50 rounded-lg border border-line-subtle">
          <p className="text-xs text-text-faint">
            Informe o IP Tailscale de cada PC remoto. O TightVNC Server deve estar rodando na porta
            5900 (ou na porta informada). Máximo de {maxMachines} PC(s). Por segurança, só são
            aceitos IPs Tailscale (100.x) — fora do túnel Tailscale a conexão não é criptografada.
          </p>
        </div>

        <div className="mt-3 p-4 bg-warning/10 rounded-lg border border-warning/30 flex gap-2">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-warning/90">
            Se uma conexão nunca chegar (fica &quot;Aguardando aprovação&quot; até dar timeout),
            verifique se o Firewall do Windows não bloqueou o OpenPortal Remote no PC de destino —
            isso costuma acontecer na primeira vez que o app roda lá. Vá em Firewall do Windows →
            Permitir um aplicativo e confirme que o OpenPortal Remote está marcado para redes
            privadas.
          </p>
        </div>
      </div>
    </div>
  );
}
