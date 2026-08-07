import { useContext, useState } from 'react';
import { MachineContext } from '../../App';

const MAX_PORT = 65535;

function isValidHost(host) {
  const h = (host || '').trim();
  if (!h) return false;
  if (/^[A-Za-z0-9.-]+$/.test(h)) return true;
  return false;
}

export default function ConfigPanel() {
  const { machines, saveMachines, addMachine, removeMachine, setShowConfig, maxMachines, addLog } = useContext(MachineContext);

  const [draft, setDraft] = useState(() => machines.map((m) => ({ ...m })));
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState({});
  const [testing, setTesting] = useState({});
  const [testResults, setTestResults] = useState({});

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
      if (addLog) addLog(res.ok
        ? `Teste OK: ${host}:${machine.port} acessível em ${res.ms}ms`
        : `Teste falhou: ${host}:${machine.port} (${res.error})`, res.ok ? 'info' : 'warn');
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [index]: { ok: false, error: err.message } }));
      if (addLog) addLog(`Erro no teste: ${err.message}`, 'error');
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
    const newMachine = { id: 'tmp-' + Date.now(), name: `PC ${draft.length + 1}`, host: '', port: 5900 };
    setDraft(prev => [...prev, newMachine]);
  };

  const handleRemoveLocal = (index) => {
    if (draft.length <= 1) return;
    setDraft(prev => prev.filter((_, i) => i !== index));
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
            <h2 className="text-2xl font-semibold text-slate-100">Configurações</h2>
            <p className="text-sm text-slate-400 mt-1">
              Configure os PCs remotos ({draft.length}/{maxMachines})
            </p>
          </div>
          <button
            onClick={() => setShowConfig(false)}
            className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
          >
            ← Voltar
          </button>
        </div>

        <div className="space-y-4">
          {draft.map((machine, index) => (
            <div
              key={machine.id}
              className={`bg-slate-800 rounded-xl p-5 border relative ${errors[index] ? 'border-red-700' : 'border-slate-700'}`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-slate-300">{machine.name || `PC ${index + 1}`}</h3>
                {draft.length > 1 && (
                  <button
                    onClick={() => handleRemoveLocal(index)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors bg-transparent border border-red-800/50 rounded px-2 py-1"
                  >
                    Remover
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Nome</label>
                  <input
                    type="text"
                    value={machine.name}
                    onChange={(e) => updateField(index, 'name', e.target.value)}
                    className={`w-full bg-slate-900 border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500 transition-colors ${errors[index] && !machine.name.trim() ? 'border-red-600' : 'border-slate-600'}`}
                    placeholder="Ex.: PC da Sala"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">IP Tailscale</label>
                  <input
                    type="text"
                    value={machine.host}
                    onChange={(e) => updateField(index, 'host', e.target.value)}
                    className={`w-full bg-slate-900 border rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors ${errors[index] && machine.host && !isValidHost(machine.host) ? 'border-red-600' : 'border-slate-600'}`}
                    placeholder="100.x.x.x"
                  />
                  {testResults[index] && (
                    <div className={`text-xs mt-1 ${testResults[index].ok ? 'text-green-400' : 'text-red-400'}`}>
                      {testResults[index].ok
                        ? `✓ Acessível em ${testResults[index].ms}ms`
                        : `✗ Falhou: ${testResults[index].error}`}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleTest(index, machine)}
                    disabled={testing[index] || !(machine.host || '').trim()}
                    className={`mt-2 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      testing[index]
                        ? 'border-slate-600 text-slate-400 cursor-wait'
                        : 'border-slate-600 text-slate-300 hover:border-blue-500 hover:text-blue-400'
                    }`}
                  >
                    {testing[index] ? 'Testando...' : 'Testar conexão'}
                  </button>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Porta VNC</label>
                  <input
                    type="number"
                    min="1"
                    max={MAX_PORT}
                    value={machine.port}
                    onChange={(e) => updateField(index, 'port', parseInt(e.target.value) || 5900)}
                    className={`w-full bg-slate-900 border rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors ${errors[index] && (machine.port < 1 || machine.port > MAX_PORT) ? 'border-red-600' : 'border-slate-600'}`}
                    placeholder="5900"
                  />
                </div>
              </div>
              {errors[index] && (
                <ul className="mt-3 space-y-1">
                  {errors[index].map((err) => (
                    <li key={err} className="text-xs text-red-400">• {err}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {draft.length < maxMachines && (
          <button
            onClick={handleAddLocal}
            className="w-full mt-4 p-3 rounded-xl border-2 border-dashed border-slate-700 text-slate-400 text-sm hover:border-slate-500 hover:text-slate-300 transition-colors bg-transparent cursor-pointer"
          >
            + Adicionar PC
          </button>
        )}

        <div className="mt-8 flex items-center gap-4">
          <button
            onClick={handleSave}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {saved ? '✓ Salvo' : 'Salvar configuração'}
          </button>
          {saved && (
            <span className="text-sm text-emerald-400">Configuração salva</span>
          )}
          {!saved && Object.keys(errors).length > 0 && (
            <span className="text-sm text-red-400">Corrija os campos destacados antes de salvar</span>
          )}
        </div>

        <div className="mt-6 p-4 bg-slate-800/50 rounded-lg border border-slate-700/50">
          <p className="text-xs text-slate-500">
            Informe o IP Tailscale de cada PC remoto. O TightVNC Server deve
            estar rodando na porta 5900 (ou na porta informada). Máximo de {maxMachines} PC(s).
          </p>
        </div>
      </div>
    </div>
  );
}
