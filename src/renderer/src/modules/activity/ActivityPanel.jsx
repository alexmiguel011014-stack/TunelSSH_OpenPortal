import { useEffect, useState } from 'react';

// Feed de atividade recebida por push (GOALS 4) — eventos que OUTRAS
// máquinas configuradas para "Reportar atividade para" (ver ConfigPanel)
// empurram para esta instância. Visual escuro/monoespaçado de propósito:
// é um painel "de sistema", como o Explorador de Arquivos, não parte do
// tema claro/escuro do resto do app.

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round((ms || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}min ${sec}s` : `${sec}s`;
}

function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '-';
}

function genId() {
  return Date.now() + '-' + Math.random().toString(16).slice(2, 6);
}

export default function ActivityPanel() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getActivityLog) {
      setLoaded(true);
      return;
    }
    api
      .getActivityLog()
      .then((log) => setEntries(Array.isArray(log) ? log.slice().reverse() : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI?.onActivityEvent?.((event) => {
      setEntries((prev) => [{ id: genId(), ...event }, ...prev]);
    });
    return unsub;
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-[#0a0e14] text-[#c9d1d9] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#1f2733]">
        <h2 className="text-base font-semibold text-white font-mono">Atividade</h2>
        <p className="text-xs text-[#6e7681] mt-1">
          Sessões reportadas por máquinas configuradas para enviar atividade para você (ver
          Configurações → Reportar atividade para).
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-sm">
        {!loaded ? (
          <div className="text-[#6e7681] text-xs">Carregando...</div>
        ) : entries.length === 0 ? (
          <div className="text-[#6e7681] text-xs">Nenhuma atividade recebida ainda.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="px-3 py-2 rounded border border-[#1f2733] bg-[#0d1117]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#58a6ff] truncate">{e.identity || 'desconhecido'}</span>
                <span className="text-[#6e7681] text-xs shrink-0">{formatTime(e.startedAt)}</span>
              </div>
              <div className="text-xs text-[#8b949e] mt-0.5">
                {e.machineName || '?'} · {formatDuration(e.durationMs)} · {e.filesTransferred || 0}{' '}
                arquivo(s)
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
