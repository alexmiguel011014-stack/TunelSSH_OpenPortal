// Regras de apresentação do registro central de acessos do laboratório (GOALS 19), sem React: os
// rótulos dos eventos, a leitura dos filtros da tela (datas locais viram milissegundos), a frase de
// cada evento e o resumo de uma reserva. Os dados vêm do main (lab/event-log.js, lab/events.js);
// os rótulos daqui precisam bater com os de lá (um teste confere).

export const TYPE_LABELS = {
  'student-added': 'Aluno adicionado',
  'student-deleted': 'Aluno apagado',
  'quota-changed': 'Cota alterada',
  'reservation-start': 'Reserva iniciada',
  'reservation-end': 'Reserva encerrada',
  'session-logon': 'Entrada do aluno',
  'session-logoff': 'Saída do aluno',
  'manager-enrolled': 'Gerente adicionado',
  'manager-removed': 'Gerente removido',
  'host-lost': 'PC sem resposta',
  'host-back': 'PC voltou',
};

export const END_REASON_LABELS = {
  'student-left': 'O aluno saiu',
  'manager-ended': 'Encerrada pelo professor',
  'manager-handover': 'Troca de aluno',
  deadline: 'Fim do prazo',
  'unused-expired': 'Reserva não usada',
  'service-restart': 'Reinício do serviço',
};

// Como o fim de uma reserva entra numa frase ("Reserva de Ana encerrada (fim do prazo)").
const END_REASON_PHRASES = {
  'student-left': 'o aluno saiu',
  'manager-ended': 'encerrada pelo professor',
  'manager-handover': 'troca de aluno',
  deadline: 'fim do prazo',
  'unused-expired': 'ninguém entrou a tempo',
  'service-restart': 'reinício do serviço',
};

const SIGN_IN_DETAILS = {
  logon: 'entrou',
  reconnect: 'reconectou',
  logoff: 'saiu',
  disconnect: 'desconectou',
};

// O que o filtro "Tipo" oferece: um grupo de tipos por opção.
export const TYPE_FILTERS = [
  { value: '', label: 'Todos os eventos', types: [] },
  {
    value: 'access',
    label: 'Entradas e saídas',
    types: ['session-logon', 'session-logoff'],
  },
  {
    value: 'reservations',
    label: 'Reservas',
    types: ['reservation-start', 'reservation-end'],
  },
  {
    value: 'students',
    label: 'Alunos e cotas',
    types: ['student-added', 'student-deleted', 'quota-changed'],
  },
  {
    value: 'managers',
    label: 'Gerentes',
    types: ['manager-enrolled', 'manager-removed'],
  },
  { value: 'hosts', label: 'PC sem resposta', types: ['host-lost', 'host-back'] },
];

export function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

export function endReasonLabel(reason) {
  return END_REASON_LABELS[reason] || '';
}

const pad = (value) => String(value).padStart(2, '0');

// "01/10/2026 14:30" no horário do computador.
export function formatDateTime(ms, timeZone) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('day')}/${pick('month')}/${pick('year')} ${pick('hour')}:${pick('minute')}`;
}

export function formatTimeOnly(ms, timeZone) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

// "1 h 05 min", "42 min", "30 s".
export function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${pad(rest)} min`;
}

// Uma data de campo <input type="date"> ("2026-10-01") no começo ou no fim do dia, no horário do
// computador. Devolve milissegundos ou undefined (campo vazio ou data torta).
export function dayBoundary(value, edge) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return undefined;
  const [, year, month, day] = match.map(Number);
  const date =
    edge === 'end'
      ? new Date(year, month - 1, day, 23, 59, 59, 999)
      : new Date(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1) return undefined;
  return date.getTime();
}

// Os campos da tela viram o filtro que o main entende (sem campo vazio).
export function filtersToQuery({
  student = '',
  hostId = '',
  from = '',
  to = '',
  typeGroup = '',
} = {}) {
  const query = {};
  if (student) query.student = student;
  if (hostId) query.hostId = hostId;
  const start = dayBoundary(from, 'start');
  const end = dayBoundary(to, 'end');
  if (start !== undefined) query.from = start;
  if (end !== undefined) query.to = end;
  const group = TYPE_FILTERS.find((option) => option.value === typeGroup);
  if (group && group.types.length) query.types = [...group.types];
  return query;
}

export function hasActiveFilters(filters) {
  return Object.keys(filtersToQuery(filters)).length > 0;
}

// Uma frase por evento, para a linha do tempo.
export function describeEvent(event) {
  const who = event.student?.label || event.student?.account || '';
  const where = event.sourceIp ? ` · de ${event.sourceIp}` : '';
  switch (event.type) {
    case 'session-logon':
    case 'session-logoff': {
      const action =
        SIGN_IN_DETAILS[event.detail] || (event.type === 'session-logon' ? 'entrou' : 'saiu');
      return `${who || 'Aluno'} ${action}${where}`;
    }
    case 'reservation-start':
      return `Reserva para ${who || 'aluno'}${event.detail ? ` (${event.detail})` : ''}`;
    case 'reservation-end': {
      const reason = END_REASON_PHRASES[event.endReason];
      return `Reserva de ${who || 'aluno'} encerrada${reason ? ` (${reason})` : ''}`;
    }
    case 'student-added':
      return `${who || 'Aluno'} adicionado${event.detail ? ` (cota ${event.detail})` : ''}`;
    case 'student-deleted':
      return `${who || 'Aluno'} apagado`;
    case 'quota-changed':
      return `Cota de ${who || 'aluno'} alterada${event.detail ? ` para ${event.detail}` : ''}`;
    case 'manager-enrolled':
      return `Gerente adicionado${event.detail ? `: ${event.detail}` : ''}`;
    case 'manager-removed':
      return `Gerente removido${event.detail ? `: ${event.detail}` : ''}`;
    case 'host-lost':
      return `O PC deixou de responder${event.detail ? ` (${event.detail})` : ''}`;
    case 'host-back':
      return 'O PC voltou a responder';
    default:
      return typeLabel(event.type);
  }
}

export function eventTone(event) {
  if (event.type === 'host-lost') return 'danger';
  if (event.type === 'host-back') return 'success';
  if (event.type === 'reservation-end' && event.endReason === 'deadline') return 'warning';
  if (event.type === 'session-logon' || event.type === 'reservation-start') return 'accent';
  return 'faint';
}

// A linha de uma reserva na lista: aluno, PC, de quando a quando e como acabou.
export function describeReservationRow(group, timeZone) {
  const who = group.student?.label || group.student?.account || 'Aluno';
  const when = group.endedAt
    ? `${formatDateTime(group.startedAt || group.events[0].at, timeZone)} → ${formatTimeOnly(group.endedAt, timeZone)}`
    : `${formatDateTime(group.startedAt || group.events[0].at, timeZone)} (em andamento)`;
  const reason = endReasonLabel(group.endReason);
  return {
    title: `${who} · ${group.hostName || 'PC'}`,
    when,
    span: group.durationMs ? formatSpan(group.durationMs) : '',
    reason,
    signIns: group.signIns.filter((s) => s.kind === 'logon').length,
  };
}

// Endereços de origem diferentes numa mesma reserva (o aluno entrou de mais de um lugar): é o que o
// professor procura quando suspeita que a senha foi passada adiante.
export function distinctSources(group) {
  return [...new Set(group.signIns.map((s) => s.sourceIp).filter(Boolean))];
}

export function describeGap(gap) {
  const range = gap.fromSeq === gap.toSeq ? `${gap.fromSeq}` : `${gap.fromSeq} a ${gap.toSeq}`;
  const reasons = {
    rotated: 'o diário do PC já não os tem (o arquivo girou ou passou do prazo)',
    missing: 'o PC não os entregou',
    reset: 'o diário do PC recomeçou do zero',
  };
  return `${gap.hostName || 'PC'}: eventos ${range} — ${reasons[gap.reason] || reasons.missing}`;
}

export function describeRetention(days) {
  if (!Number.isFinite(days)) return '';
  if (days === 1) return '1 dia';
  if (days % 365 === 0) return days === 365 ? '1 ano' : `${days / 365} anos`;
  return `${days} dias`;
}

// Baixar o CSV no navegador do app (a janela de salvar é do Electron).
export function downloadText(filename, text, doc = document, urlApi = URL) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  setTimeout(() => urlApi.revokeObjectURL(url), 1000);
}
