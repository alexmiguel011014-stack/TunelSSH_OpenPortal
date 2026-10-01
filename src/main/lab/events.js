'use strict';

// Eventos do laboratório (GOALS 19): o esquema v2 que o PC gerenciado registra no diário do serviço
// e entrega ao gerente (por push e por consulta de sequência), a leitura dos eventos antigos do
// GOALS 4 (sem `v`), o agrupamento por reserva e a exportação em CSV. Sem rede, sem disco, sem
// Electron: tudo aqui é função pura, porque o que vem da rede é entrada de um PC que não é de
// confiança e nada daqui lança exceção para entrada ruim.

const net = require('net');

const EVENT_VERSION = 2;

// Os fatos que o serviço e o app registram num PC gerenciado.
const PC_EVENT_TYPES = Object.freeze([
  'student-added',
  'student-deleted',
  'quota-changed',
  'reservation-start',
  'reservation-end',
  'session-logon',
  'session-logoff',
  'manager-enrolled',
  'manager-removed',
]);
// Os que só o GERENTE cria, quando um PC com reserva deixa de responder (e quando volta). Um PC
// nunca os entrega: o que chega da rede com esses tipos é descartado.
const MANAGER_EVENT_TYPES = Object.freeze(['host-lost', 'host-back']);
const EVENT_TYPES = Object.freeze([...PC_EVENT_TYPES, ...MANAGER_EVENT_TYPES]);

const END_REASONS = Object.freeze([
  'student-left',
  'manager-ended',
  'manager-handover',
  'deadline',
  'unused-expired',
  'service-restart',
]);

const MAX_DETAIL = 200;
const ACCOUNT_PATTERN = /^[a-z0-9_-]{1,20}$/;
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MIN_TIME = Date.UTC(2000, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return [...value.replace(CONTROL_CHARS, ' ').trim()].slice(0, max).join('');
}

function isSafeTime(value) {
  return Number.isSafeInteger(value) && value >= MIN_TIME && value <= MAX_TIME;
}

function normalizeIp(address) {
  if (typeof address !== 'string') return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

// Diz que formato um evento tem: 'v2' (esquema novo), 'legacy' (GOALS 4, sem `v`) ou null.
function classifyEvent(input) {
  if (!isPlainObject(input)) return null;
  if (input.v === undefined) return 'legacy';
  return input.v === EVENT_VERSION ? 'v2' : null;
}

// Lê um evento v2. `local: true` aceita também os tipos do gerente (host-lost/host-back) e o
// número de sequência 0 (eventos que o gerente cria; não vêm do diário de um PC). Devolve
// { ok: true, event } com SÓ os campos conhecidos, ou { ok: false, error }.
function validateEvent(input, { local = false } = {}) {
  if (!isPlainObject(input)) return { ok: false, error: 'not-an-object' };
  if (input.v !== EVENT_VERSION) return { ok: false, error: 'bad-version' };
  const hostId = typeof input.hostId === 'string' ? input.hostId.trim() : '';
  if (hostId.length < 1 || hostId.length > 64) return { ok: false, error: 'bad-host' };
  if (!EVENT_TYPES.includes(input.type)) return { ok: false, error: 'bad-type' };
  if (!local && MANAGER_EVENT_TYPES.includes(input.type)) return { ok: false, error: 'bad-type' };
  const minSeq = local && MANAGER_EVENT_TYPES.includes(input.type) ? 0 : 1;
  if (!Number.isSafeInteger(input.seq) || input.seq < minSeq)
    return { ok: false, error: 'bad-seq' };
  if (!isSafeTime(input.at)) return { ok: false, error: 'bad-time' };

  const event = {
    v: EVENT_VERSION,
    hostId,
    hostName: cleanText(input.hostName, 100),
    seq: input.seq,
    at: input.at,
    type: input.type,
  };
  if (input.student !== undefined) {
    if (!isPlainObject(input.student)) return { ok: false, error: 'bad-student' };
    const account = typeof input.student.account === 'string' ? input.student.account : '';
    if (account && !ACCOUNT_PATTERN.test(account)) return { ok: false, error: 'bad-student' };
    event.student = { label: cleanText(input.student.label, 40), account };
  }
  if (input.reservationId !== undefined) {
    if (
      typeof input.reservationId !== 'string' ||
      !RESERVATION_ID_PATTERN.test(input.reservationId)
    ) {
      return { ok: false, error: 'bad-reservation' };
    }
    event.reservationId = input.reservationId;
  }
  if (input.sourceIp !== undefined) {
    if (typeof input.sourceIp !== 'string' || net.isIP(input.sourceIp) === 0) {
      return { ok: false, error: 'bad-ip' };
    }
    event.sourceIp = input.sourceIp;
  }
  if (input.endReason !== undefined) {
    if (input.type !== 'reservation-end' || !END_REASONS.includes(input.endReason)) {
      return { ok: false, error: 'bad-reason' };
    }
    event.endReason = input.endReason;
  }
  if (input.detail !== undefined) {
    if (typeof input.detail !== 'string') return { ok: false, error: 'bad-detail' };
    const detail = cleanText(input.detail, MAX_DETAIL);
    if (detail) event.detail = detail;
  }
  return { ok: true, event };
}

// Evento do GOALS 4 (uma sessão que aconteceu em outro PC): { identity, machineName, startedAt,
// endedAt, durationMs, filesTransferred }. Devolve o evento limpo ou null.
function normalizeLegacy(input) {
  if (!isPlainObject(input)) return null;
  const identity = cleanText(input.identity, 200);
  const machineName = cleanText(input.machineName, 100);
  if (!identity || !machineName) return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    identity,
    machineName,
    startedAt: isSafeTime(input.startedAt) ? input.startedAt : 0,
    endedAt: isSafeTime(input.endedAt) ? input.endedAt : 0,
    durationMs: count(input.durationMs),
    filesTransferred: count(input.filesTransferred),
  };
}

// Uma linha do diário do serviço ({ seq, at, type, account, label, reservationId, sourceIp,
// endReason, detail }) vira um evento v2 do PC `host`. Devolve o evento válido ou null.
function fromJournalEntry(entry, host) {
  if (!isPlainObject(entry) || !isPlainObject(host)) return null;
  const candidate = {
    v: EVENT_VERSION,
    hostId: host.hostId,
    hostName: host.hostName,
    seq: entry.seq,
    at: entry.at,
    type: entry.type,
  };
  if (typeof entry.account === 'string' && entry.account) {
    candidate.student = { label: entry.label ?? '', account: entry.account };
  }
  for (const key of ['reservationId', 'sourceIp', 'endReason', 'detail']) {
    if (entry[key] !== undefined && entry[key] !== null) candidate[key] = entry[key];
  }
  const result = validateEvent(candidate);
  return result.ok ? result.event : null;
}

// ---- Agrupar por reserva ---------------------------------------------------------

// Junta os eventos de cada reserva: aluno, início, fim, duração, motivo, e as entradas (horário,
// endereço de origem). `events` já filtrados; devolve do mais recente ao mais antigo.
function groupReservations(events) {
  const byId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event.reservationId) continue;
    const key = `${event.hostId}:${event.reservationId}`;
    let group = byId.get(key);
    if (!group) {
      group = {
        key,
        reservationId: event.reservationId,
        hostId: event.hostId,
        hostName: event.hostName,
        student: event.student || null,
        startedAt: 0,
        endedAt: 0,
        endReason: '',
        firstLogonAt: 0,
        signIns: [],
        events: [],
      };
      byId.set(key, group);
    }
    group.events.push(event);
    if (event.student && !group.student) group.student = event.student;
    if (event.type === 'reservation-start') group.startedAt = event.at;
    if (event.type === 'reservation-end') {
      group.endedAt = event.at;
      group.endReason = event.endReason || '';
    }
    if (event.type === 'session-logon' || event.type === 'session-logoff') {
      group.signIns.push({
        at: event.at,
        kind: event.type === 'session-logon' ? 'logon' : 'logoff',
        detail: event.detail || '',
        sourceIp: event.sourceIp || '',
      });
      if (
        event.type === 'session-logon' &&
        (!group.firstLogonAt || event.at < group.firstLogonAt)
      ) {
        group.firstLogonAt = event.at;
      }
    }
  }
  const groups = [...byId.values()];
  for (const group of groups) {
    group.events.sort((a, b) => a.at - b.at || a.seq - b.seq);
    group.signIns.sort((a, b) => a.at - b.at);
    // Duração = do primeiro acesso ao fim; sem acesso (reserva não usada), do início ao fim.
    const from = group.firstLogonAt || group.startedAt;
    group.durationMs = group.endedAt && from ? Math.max(0, group.endedAt - from) : 0;
  }
  return groups.sort((a, b) => (b.startedAt || b.events[0].at) - (a.startedAt || a.events[0].at));
}

// ---- Texto para a tela e para o CSV ------------------------------------------------

const TYPE_LABELS = Object.freeze({
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
});

const END_REASON_LABELS = Object.freeze({
  'student-left': 'O aluno saiu',
  'manager-ended': 'Encerrada pelo professor',
  'manager-handover': 'Troca de aluno',
  deadline: 'Fim do prazo',
  'unused-expired': 'Reserva não usada',
  'service-restart': 'Reinício do serviço',
});

const DETAIL_LABELS = Object.freeze({
  logon: 'entrou',
  reconnect: 'reconectou',
  logoff: 'saiu',
  disconnect: 'desconectou',
});

function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

function endReasonLabel(reason) {
  return END_REASON_LABELS[reason] || '';
}

function detailLabel(event) {
  if ((event.type === 'session-logon' || event.type === 'session-logoff') && event.detail) {
    return DETAIL_LABELS[event.detail] || event.detail;
  }
  return event.detail || '';
}

// ---- CSV -------------------------------------------------------------------------

const CSV_COLUMNS = Object.freeze([
  'Data e hora (local)',
  'Data e hora (UTC)',
  'PC',
  'Aluno',
  'Conta',
  'Evento',
  'Código',
  'Motivo do fim',
  'Endereço de origem',
  'Reserva',
  'Detalhe',
  'Sequência',
  'Recebido em (local)',
]);

function pad(value) {
  return String(value).padStart(2, '0');
}

// dd/mm/aaaa hh:mm:ss no fuso pedido (o do computador por padrão).
function formatLocal(ms, timeZone) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${pick('day')}/${pick('month')}/${pick('year')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function formatUtc(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

// Uma célula: entre aspas quando tem `;`, aspas ou quebra de linha (aspas dobradas). Um texto que
// começaria com `=`, `+`, `-` ou `@` ganha um apóstrofo na frente, para a planilha não o executar
// como fórmula (os nomes dos alunos e os detalhes vêm de outros PCs).
function csvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[;"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(cells) {
  return cells.map(csvCell).join(';');
}

// CSV para planilha em português: separador `;`, vírgula livre, BOM UTF-8 (para os acentos
// abrirem certo no Excel), quebra de linha CRLF e duas colunas de hora (local e UTC).
// `received` (opcional): { [chave]: receivedAt } para a coluna "Recebido em".
function buildCsv(events, { timeZone, receivedAt = () => 0 } = {}) {
  const lines = [csvRow(CSV_COLUMNS)];
  for (const event of Array.isArray(events) ? events : []) {
    lines.push(
      csvRow([
        formatLocal(event.at, timeZone),
        formatUtc(event.at),
        event.hostName || '',
        event.student?.label || '',
        event.student?.account || '',
        typeLabel(event.type),
        event.type,
        endReasonLabel(event.endReason),
        event.sourceIp || '',
        event.reservationId || '',
        detailLabel(event),
        event.seq > 0 ? event.seq : '',
        formatLocal(receivedAt(event), timeZone),
      ]),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = {
  CSV_COLUMNS,
  END_REASONS,
  EVENT_TYPES,
  EVENT_VERSION,
  MANAGER_EVENT_TYPES,
  PC_EVENT_TYPES,
  buildCsv,
  classifyEvent,
  csvCell,
  detailLabel,
  endReasonLabel,
  formatLocal,
  formatUtc,
  fromJournalEntry,
  groupReservations,
  normalizeIp,
  normalizeLegacy,
  typeLabel,
  validateEvent,
};
