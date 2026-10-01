import { useEffect, useMemo, useState } from 'react';
import {
  TYPE_FILTERS,
  describeEvent,
  describeGap,
  describeReservationRow,
  describeRetention,
  distinctSources,
  downloadText,
  endReasonLabel,
  eventTone,
  filtersToQuery,
  formatDateTime,
  hasActiveFilters,
  typeLabel,
} from '../../shared/lib/labLog';

// O registro central de acessos do laboratório (GOALS 19): quem usou qual PC, quando, de que
// endereço entrou e como a reserva acabou. Visual escuro/monoespaçado como o resto do painel de
// Atividade. Os dados vêm do main (lab/event-log.js); aqui só filtros, lista e exportação.

const TONES = {
  danger: 'text-[#f85149]',
  success: 'text-[#3fb950]',
  warning: 'text-[#d29922]',
  accent: 'text-[#58a6ff]',
  faint: 'text-[#8b949e]',
};

const field =
  'bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#c9d1d9] outline-none focus:border-[#58a6ff]';

function Drawer({ group, onClose }) {
  const row = describeReservationRow(group);
  const sources = distinctSources(group);
  return (
    <aside
      aria-label="Detalhes da reserva"
      className="fixed inset-y-0 right-0 z-[9000] w-full max-w-md bg-[#0d1117] border-l border-[#30363d] shadow-2xl overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[#1f2733]">
        <div className="min-w-0">
          <div className="text-white text-sm font-semibold truncate">{row.title}</div>
          <div className="text-[11px] text-[#6e7681]">{group.student?.account || ''}</div>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-[#8b949e] hover:text-white border border-[#30363d] rounded px-2 py-1"
        >
          Fechar
        </button>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
        <dt className="text-[#6e7681]">Início</dt>
        <dd>{formatDateTime(group.startedAt)}</dd>
        <dt className="text-[#6e7681]">Primeira entrada</dt>
        <dd>{group.firstLogonAt ? formatDateTime(group.firstLogonAt) : 'o aluno não entrou'}</dd>
        <dt className="text-[#6e7681]">Fim</dt>
        <dd>{group.endedAt ? formatDateTime(group.endedAt) : 'em andamento'}</dd>
        <dt className="text-[#6e7681]">Duração</dt>
        <dd>{row.span || '—'}</dd>
        <dt className="text-[#6e7681]">Como acabou</dt>
        <dd>{endReasonLabel(group.endReason) || '—'}</dd>
        <dt className="text-[#6e7681]">Endereços</dt>
        <dd className={sources.length > 1 ? 'text-[#d29922]' : ''}>
          {sources.length ? sources.join(', ') : '—'}
          {sources.length > 1 && ' (mais de um endereço: a senha pode ter sido passada adiante)'}
        </dd>
      </dl>
      <div className="px-4 pb-1 text-[11px] uppercase tracking-wide text-[#6e7681]">
        Entradas e saídas
      </div>
      <ul className="px-4 pb-3 space-y-1 text-xs">
        {group.signIns.length === 0 && (
          <li className="text-[#6e7681]">Nenhuma entrada registrada.</li>
        )}
        {group.signIns.map((s, index) => (
          <li key={`${s.at}-${index}`} className="flex justify-between gap-3">
            <span>
              {formatDateTime(s.at)} ·{' '}
              {s.kind === 'logon'
                ? s.detail === 'reconnect'
                  ? 'reconectou'
                  : 'entrou'
                : s.detail === 'disconnect'
                  ? 'desconectou'
                  : 'saiu'}
            </span>
            <span className="text-[#8b949e]">{s.sourceIp || 'sem endereço'}</span>
          </li>
        ))}
      </ul>
      <div className="px-4 pb-1 text-[11px] uppercase tracking-wide text-[#6e7681]">
        Todos os eventos
      </div>
      <ul className="px-4 pb-6 space-y-1 text-xs">
        {group.events.map((event) => (
          <li
            key={`${event.hostId}:${event.seq}:${event.type}:${event.at}`}
            className="flex justify-between gap-3"
          >
            <span className={TONES[eventTone(event)]}>{typeLabel(event.type)}</span>
            <span className="text-[#8b949e]">{formatDateTime(event.at)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default function LabLogView() {
  const [filters, setFilters] = useState({
    student: '',
    hostId: '',
    from: '',
    to: '',
    typeGroup: '',
  });
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [retention, setRetention] = useState({ days: null, draft: '', message: '' });
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.queryLabLog) return undefined;
    let alive = true;
    api
      .queryLabLog(JSON.parse(queryKey))
      .then((result) => {
        if (!alive) return;
        if (result?.ok) {
          setData(result);
          setError('');
        } else {
          setError(result?.message || 'Não foi possível ler o registro');
        }
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [queryKey, tick]);

  // Chegou evento novo: atualiza a lista.
  useEffect(() => window.electronAPI?.onLabLogChanged?.(() => setTick((value) => value + 1)), []);

  useEffect(() => {
    let alive = true;
    window.electronAPI
      ?.getLabLogRetention?.()
      .then((result) => {
        if (alive && result?.ok) {
          setRetention((current) => ({
            ...current,
            days: result.days,
            draft: String(result.days),
          }));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const set = (name) => (event) =>
    setFilters((current) => ({ ...current, [name]: event.target.value }));

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await window.electronAPI.exportLabLog(query);
      if (result?.ok) downloadText(result.filename, result.csv);
      else setError(result?.message || 'Não foi possível exportar');
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const saveRetention = async () => {
    const days = Number(retention.draft);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      setRetention((current) => ({ ...current, message: 'Informe de 1 a 3650 dias' }));
      return;
    }
    const result = await window.electronAPI.setLabLogRetention(days);
    if (result?.ok) {
      setRetention({
        days: result.days,
        draft: String(result.days),
        message: result.removed ? `${result.removed} registro(s) antigos apagados` : 'Salvo',
      });
      setTick((value) => value + 1);
    } else {
      setRetention((current) => ({
        ...current,
        message: result?.message || 'Não foi possível salvar',
      }));
    }
  };

  const events = useMemo(() => data?.events || [], [data]);
  const reservations = data?.reservations || [];
  const gaps = data?.gaps || [];
  const facets = data?.facets || { hosts: [], students: [] };
  const timeline = useMemo(() => events.slice().reverse(), [events]);
  const filtered = hasActiveFilters(filters);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-5 py-3 border-b border-[#1f2733] flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-[#6e7681]">
          Aluno
          <select
            value={filters.student}
            onChange={set('student')}
            className={`${field} block mt-0.5 w-40`}
          >
            <option value="">Todos</option>
            {facets.students.map((student) => (
              <option key={student.account} value={student.account}>
                {student.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-[#6e7681]">
          PC
          <select
            value={filters.hostId}
            onChange={set('hostId')}
            className={`${field} block mt-0.5 w-36`}
          >
            <option value="">Todos</option>
            {facets.hosts.map((host) => (
              <option key={host.hostId} value={host.hostId}>
                {host.hostName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-[#6e7681]">
          De
          <input
            type="date"
            value={filters.from}
            onChange={set('from')}
            className={`${field} block mt-0.5`}
          />
        </label>
        <label className="text-[11px] text-[#6e7681]">
          Até
          <input
            type="date"
            value={filters.to}
            onChange={set('to')}
            className={`${field} block mt-0.5`}
          />
        </label>
        <label className="text-[11px] text-[#6e7681]">
          Tipo
          <select
            value={filters.typeGroup}
            onChange={set('typeGroup')}
            className={`${field} block mt-0.5 w-40`}
          >
            {TYPE_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            onClick={() => setFilters({ student: '', hostId: '', from: '', to: '', typeGroup: '' })}
            className="text-xs text-[#8b949e] hover:text-white border border-[#30363d] rounded px-2 py-1"
          >
            Limpar filtros
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={handleExport}
          disabled={exporting || events.length === 0}
          className="text-xs border border-[#238636] text-[#3fb950] hover:bg-[#238636]/20 rounded px-3 py-1 disabled:opacity-40"
        >
          Exportar CSV
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-sm">
        {error && (
          <div role="alert" className="text-xs text-[#f85149]">
            {error}
          </div>
        )}
        {!data && !error && <div className="text-[#6e7681] text-xs">Carregando...</div>}

        {data && (
          <>
            <div className="text-[11px] text-[#6e7681]" role="status">
              {data.total} evento(s){filtered ? ' com estes filtros' : ''} · {reservations.length}{' '}
              reserva(s)
              {data.truncated ? ` · mostrando os ${events.length} mais recentes` : ''}
            </div>

            {gaps.length > 0 && (
              <details className="text-xs border border-[#d29922]/40 rounded px-3 py-2 bg-[#d29922]/5">
                <summary className="cursor-pointer text-[#d29922]">
                  {gaps.length} lacuna(s) no registro
                </summary>
                <ul className="mt-2 space-y-1 text-[#8b949e]">
                  {gaps.map((gap) => (
                    <li key={`${gap.hostId}:${gap.fromSeq}:${gap.toSeq}`}>{describeGap(gap)}</li>
                  ))}
                </ul>
              </details>
            )}

            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-[#6e7681] mb-2">Reservas</h3>
              {reservations.length === 0 ? (
                <div className="text-[#6e7681] text-xs">
                  {filtered
                    ? 'Nenhuma reserva com estes filtros.'
                    : 'Nenhuma reserva registrada ainda.'}
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {reservations.map((group) => {
                    const row = describeReservationRow(group);
                    const sources = distinctSources(group);
                    return (
                      <li key={group.key}>
                        <button
                          onClick={() => setSelected(group)}
                          className="w-full text-left px-3 py-2 rounded border border-[#1f2733] bg-[#0d1117] hover:border-[#30363d]"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[#58a6ff] truncate">{row.title}</span>
                            <span className="text-[#6e7681] text-xs shrink-0">{row.when}</span>
                          </div>
                          <div className="text-xs text-[#8b949e] mt-0.5">
                            {[row.span, row.reason, `${row.signIns} entrada(s)`, sources.join(', ')]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-[#6e7681] mb-2">
                Linha do tempo
              </h3>
              {timeline.length === 0 ? (
                <div className="text-[#6e7681] text-xs">Nenhum evento.</div>
              ) : (
                <ul className="space-y-1">
                  {timeline.map((event) => (
                    <li
                      key={`${event.hostId}:${event.seq}:${event.type}:${event.at}`}
                      className="flex items-baseline gap-3 px-3 py-1.5 rounded border border-[#1f2733] bg-[#0d1117] text-xs"
                    >
                      <span className="text-[#6e7681] shrink-0 w-32">
                        {formatDateTime(event.at)}
                      </span>
                      <span className="text-[#8b949e] shrink-0 w-24 truncate">
                        {event.hostName}
                      </span>
                      <span className={`${TONES[eventTone(event)]} min-w-0 truncate`}>
                        {describeEvent(event)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <section className="border-t border-[#1f2733] pt-3 text-xs text-[#8b949e]">
          <label className="flex flex-wrap items-center gap-2">
            Guardar o registro por
            <input
              type="number"
              min="1"
              max="3650"
              value={retention.draft}
              onChange={(e) =>
                setRetention((current) => ({ ...current, draft: e.target.value, message: '' }))
              }
              className={`${field} w-20`}
              aria-label="Dias de retenção"
            />
            dias
            {retention.days ? (
              <span className="text-[#6e7681]">(hoje: {describeRetention(retention.days)})</span>
            ) : null}
            <button
              onClick={saveRetention}
              className="border border-[#30363d] rounded px-2 py-1 hover:text-white"
            >
              Salvar
            </button>
            {retention.message && <span role="status">{retention.message}</span>}
          </label>
        </section>
      </div>

      {selected && <Drawer group={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
