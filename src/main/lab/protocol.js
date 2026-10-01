'use strict';

// Protocolo `lab-*` do modo laboratório (GOALS 16–19), na mesma porta de
// sinalização (18902) do connect-request: um objeto JSON por conexão. A
// especificação está em docs/ARQUITETURA_CONEXAO.md ("Modo laboratório"); este
// módulo só monta, lê e valida as mensagens — sem rede, sem Electron, sem
// exceções para entrada ruim (a porta é alcançável por qualquer peer).

const events = require('./events');

const LAB_PROTOCOL = 1;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

const ERROR_CODES = Object.freeze([
  'unauthorized',
  'locked',
  'busy',
  'bad-request',
  'unsupported',
  'internal',
  // GOALS 18: o que o serviço do laboratório recusa ou não consegue fazer.
  'not-found',
  'full',
  'logoff-failed',
  'service-down',
]);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS_EVERYWHERE = new RegExp(CONTROL_CHARS.source, 'g');
const ACCOUNT_PATTERN = /^[a-z0-9_-]{1,20}$/;
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const text = (min, max) => ({ kind: 'text', min, max });
const integer = (min, max) => ({ kind: 'int', min, max });
const pattern = (regex) => ({ kind: 'pattern', regex });
const oneOf = (values) => ({ kind: 'enum', values });

const account = pattern(ACCOUNT_PATTERN);
const quotaGb = integer(1, 2000);

// Campos aceitos por tipo de pedido; o que não está aqui é ignorado.
const REQUEST_FIELDS = Object.freeze({
  'lab-enroll': {},
  'lab-status': {},
  'lab-students': {},
  'lab-student-add': { label: text(1, 40), quotaGb },
  'lab-student-quota': { account, quotaGb },
  'lab-student-delete': { account },
  'lab-reserve': {
    account,
    startWithinMs: integer(MINUTE, 24 * HOUR),
    sessionMs: integer(5 * MINUTE, 12 * HOUR),
  },
  'lab-extend': {
    reservationId: pattern(RESERVATION_ID_PATTERN),
    addMs: integer(MINUTE, 12 * HOUR),
  },
  'lab-end': {
    reservationId: pattern(RESERVATION_ID_PATTERN),
    reason: oneOf(['manager-ended', 'manager-handover']),
  },
  'lab-folder': { account },
  'lab-events': {
    sinceSeq: integer(0, Number.MAX_SAFE_INTEGER),
    limit: integer(1, 500),
  },
});

// O que este build responde de fato; o resto é `unsupported` até o GOALS dono
// da mensagem chegar.
const IMPLEMENTED_TYPES = Object.freeze(
  new Set([
    'lab-enroll',
    'lab-status',
    'lab-students',
    'lab-student-add',
    'lab-student-quota',
    'lab-student-delete',
    'lab-reserve',
    'lab-extend',
    'lab-end',
    'lab-folder',
    'lab-events',
  ]),
);

// Marca, numa resposta de `lab-folder`, que a conexão deve virar uma sessão de
// arquivos somente leitura na pasta indicada. Chave Symbol: não vai para o JSON.
const FILE_SESSION = Symbol.for('openportal.lab.fileSession');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(error, message, extra = {}) {
  return { ok: false, error, message, ...extra };
}

function readField(spec, value) {
  switch (spec.kind) {
    case 'text': {
      if (typeof value !== 'string') return { ok: false };
      const trimmed = value.trim();
      const length = [...trimmed].length;
      if (length < spec.min || length > spec.max || CONTROL_CHARS.test(trimmed)) {
        return { ok: false };
      }
      return { ok: true, value: trimmed };
    }
    case 'int':
      if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
        return { ok: false };
      }
      return { ok: true, value };
    case 'pattern':
      if (typeof value !== 'string' || !spec.regex.test(value)) return { ok: false };
      return { ok: true, value };
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) return { ok: false };
      return { ok: true, value };
    default:
      return { ok: false };
  }
}

function readFields(type, source) {
  const fields = {};
  for (const [name, spec] of Object.entries(REQUEST_FIELDS[type])) {
    if (!(name in source)) return failure('bad-request', `Campo ausente: ${name}`);
    const read = readField(spec, source[name]);
    if (!read.ok) return failure('bad-request', `Campo inválido: ${name}`);
    fields[name] = read.value;
  }
  return { ok: true, fields };
}

function toText(input) {
  if (typeof input === 'string') return input;
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  return null;
}

// Lê um pedido recebido da rede. `input` é o texto/Buffer cru (o limite de
// 4 KiB vale sobre ele) ou um objeto já lido do JSON. Devolve
// { ok: true, request } com só os campos do tipo, ou { ok: false, error,
// message } com `error` = 'bad-request' | 'unsupported'.
function parseRequest(input) {
  let message = input;
  const raw = toText(input);
  if (raw !== null) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
      return failure('bad-request', 'Pedido grande demais');
    }
    try {
      message = JSON.parse(raw);
    } catch {
      return failure('bad-request', 'JSON inválido');
    }
  }
  if (!isPlainObject(message)) return failure('bad-request', 'Pedido não é um objeto');
  const { type, labProtocol } = message;
  if (typeof type !== 'string' || !type.startsWith('lab-')) {
    return failure('bad-request', 'Tipo de pedido ausente');
  }
  if (!Number.isSafeInteger(labProtocol) || labProtocol < 1) {
    return failure('bad-request', 'labProtocol ausente ou inválido');
  }
  if (!Object.hasOwn(REQUEST_FIELDS, type)) {
    return failure('unsupported', 'Tipo de pedido desconhecido', {
      labProtocol: LAB_PROTOCOL,
    });
  }
  if (labProtocol > LAB_PROTOCOL) {
    return failure('unsupported', 'Versão do protocolo mais nova que a deste PC', {
      labProtocol: LAB_PROTOCOL,
    });
  }
  const read = readFields(type, message);
  if (!read.ok) return read;
  return { ok: true, request: { type, labProtocol, ...read.fields } };
}

// Monta um pedido para enviar. Devolve { ok: true, request, text } ou
// { ok: false, error: 'bad-request', message } — o gerente nunca envia algo
// que o próprio PC recusaria por forma.
function buildRequest(type, fields = {}) {
  if (typeof type !== 'string' || !Object.hasOwn(REQUEST_FIELDS, type)) {
    return failure('unsupported', 'Tipo de pedido desconhecido');
  }
  const read = readFields(type, isPlainObject(fields) ? fields : {});
  if (!read.ok) return read;
  const request = { type, labProtocol: LAB_PROTOCOL, ...read.fields };
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    return failure('bad-request', 'Pedido grande demais');
  }
  return { ok: true, request, text: body };
}

function buildSuccess(requestType, fields = {}) {
  return {
    type: 'lab-response',
    request: requestType,
    ok: true,
    labProtocol: LAB_PROTOCOL,
    ...fields,
  };
}

// `busyWith`: quem está com o PC quando a recusa é `busy` (nome, estado e fim).
function buildError(requestType, error, message, { busyWith } = {}) {
  const code = ERROR_CODES.includes(error) ? error : 'internal';
  const who = busyWith ? busyPayload(busyWith) : null;
  return {
    type: 'lab-response',
    request: requestType,
    ok: false,
    error: code,
    ...(message ? { message: String(message) } : {}),
    ...(who ? { busyWith: who } : {}),
    labProtocol: LAB_PROTOCOL,
  };
}

// Serializa uma resposta respeitando o limite de 256 KiB: maior que isso vira
// um erro 'internal', em vez de uma resposta que o outro lado recusaria.
function serializeResponse(response) {
  let body;
  try {
    body = JSON.stringify(response);
  } catch {
    body = null;
  }
  if (body && Buffer.byteLength(body, 'utf8') <= MAX_RESPONSE_BYTES) return body;
  return JSON.stringify(buildError(response?.request, 'internal', 'Resposta grande demais'));
}

// Lê uma resposta recebida (lado do gerente). Nunca lança.
function parseResponse(input) {
  const raw = toText(input);
  let message = input;
  if (raw !== null) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
      return failure('bad-response', 'Resposta grande demais');
    }
    try {
      message = JSON.parse(raw);
    } catch {
      return failure('bad-response', 'JSON inválido');
    }
  }
  if (
    !isPlainObject(message) ||
    message.type !== 'lab-response' ||
    typeof message.ok !== 'boolean'
  ) {
    return failure('bad-response', 'Resposta inválida');
  }
  if (!message.ok) {
    const error = ERROR_CODES.includes(message.error) ? message.error : 'internal';
    return {
      ok: true,
      response: {
        ...message,
        error,
        message: typeof message.message === 'string' ? message.message : undefined,
      },
    };
  }
  return { ok: true, response: message };
}

const STATES = ['free', 'reserved', 'in-use'];

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return [...value.replace(CONTROL_CHARS_EVERYWHERE, ' ').trim()].slice(0, max).join('');
}

function cleanCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanGb(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 10) / 10
    : null;
}

// Campos da resposta de `lab-status`, montados por lista de permitidos: o que
// a camada de baixo devolver além disto (senha, token, segredo) não passa. Usada
// também pelo gerente para ler a resposta de um PC que não é de confiança.
function statusPayload(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const service = isPlainObject(source.service) ? source.service : {};
  const state = STATES.includes(source.state) ? source.state : 'free';
  const payload = {
    hostId: cleanText(source.hostId, 64),
    hostName: cleanText(source.hostName, 100),
    appVersion: cleanText(source.appVersion, 40),
    managed: source.managed === true,
    service: {
      installed: service.installed === true,
      running: service.running === true,
    },
    state,
    studentCount: cleanCount(source.studentCount),
    // O número do último evento do diário do PC: o gerente sabe se está atrasado (GOALS 19).
    lastSeq: cleanCount(source.lastSeq),
  };
  if (isPlainObject(source.student) && state !== 'free') {
    payload.student = {
      label: cleanText(source.student.label, 40),
      since: cleanCount(source.student.since),
      endsAt: cleanCount(source.student.endsAt),
    };
  }
  if (isPlainObject(source.disk)) {
    const totalGb = cleanGb(source.disk.totalGb);
    const freeGb = cleanGb(source.disk.freeGb);
    if (totalGb !== null && freeGb !== null) payload.disk = { totalGb, freeGb };
  }
  return payload;
}

// ---- GOALS 18: alunos, reserva e credenciais --------------------------------
// Listas de permitidos também aqui: o PC gerenciado monta a resposta a partir do
// que o serviço devolve, e o gerente lê a resposta de um PC que não é de confiança.

const STUDENT_STATES = ['free', 'reserved', 'in-use', 'ending'];
const RESERVATION_STATES = ['reserved', 'in-use', 'ending'];
const QUOTA_STATES = ['off', 'track', 'enforce', 'unknown'];
const CAPACITY_STATUS = ['ok', 'tight', 'over'];
const MAX_STUDENTS_LISTED = 100;
const GB = 1024 * 1024 * 1024;

function cleanChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function cleanAccount(value) {
  return typeof value === 'string' && ACCOUNT_PATTERN.test(value) ? value : '';
}

function cleanReservationId(value) {
  return typeof value === 'string' && RESERVATION_ID_PATTERN.test(value) ? value : '';
}

function bytesToGb(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
    ? Math.round((bytes / GB) * 100) / 100
    : null;
}

function cleanGb2(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : null;
}

function studentPayload(input) {
  const source = isPlainObject(input) ? input : {};
  const usedGb =
    source.usedBytes !== undefined ? bytesToGb(source.usedBytes) : cleanGb2(source.usedGb);
  const quota = source.quotaGb;
  const student = {
    account: cleanAccount(source.account),
    label: cleanText(source.label, 40),
    quotaGb: Number.isSafeInteger(quota) && quota >= 1 && quota <= 2000 ? quota : 0,
    state: cleanChoice(source.state, STUDENT_STATES, 'free'),
    lastSessionEnd: cleanCount(source.lastSessionEnd),
  };
  if (usedGb !== null) student.usedGb = usedGb;
  return student;
}

function reservationPayload(input) {
  if (!isPlainObject(input)) return null;
  const id = cleanReservationId(input.id);
  const account = cleanAccount(input.account);
  if (!id || !account) return null;
  return {
    id,
    account,
    label: cleanText(input.label, 40),
    state: cleanChoice(input.state, RESERVATION_STATES, 'reserved'),
    startBy: cleanCount(input.startBy),
    endsAt: cleanCount(input.endsAt),
    createdAt: cleanCount(input.createdAt),
    firstLogonAt: cleanCount(input.firstLogonAt),
  };
}

function capacityPayload(input) {
  if (!isPlainObject(input)) return null;
  const totalGb = cleanGb(input.totalGb);
  const freeGb = cleanGb(input.freeGb);
  if (totalGb === null || freeGb === null) return null;
  return {
    totalGb,
    freeGb,
    reserveGb: cleanGb(input.reserveGb) ?? 0,
    quotaGb: cleanGb(input.quotaGb) ?? 0,
    recommended: cleanCount(input.recommended),
    assignedGb: cleanGb(input.assignedGb) ?? 0,
    usedByStudentsGb: cleanGb(input.usedByStudentsGb) ?? 0,
    status: cleanChoice(input.status, CAPACITY_STATUS, 'ok'),
  };
}

// Resposta de `lab-students`: os alunos do PC, a reserva em andamento, o estado
// da cota e a caixa de capacidade do disco.
function studentsPayload(input) {
  const source = isPlainObject(input) ? input : {};
  const list = Array.isArray(source.students) ? source.students : [];
  const payload = {
    students: list
      .slice(0, MAX_STUDENTS_LISTED)
      .map(studentPayload)
      .filter((student) => student.account),
    quota: cleanChoice(source.quota, QUOTA_STATES, 'unknown'),
  };
  const reservation = reservationPayload(source.reservation);
  if (reservation) payload.reservation = reservation;
  const capacity = capacityPayload(source.capacity);
  if (capacity) payload.capacity = capacity;
  return payload;
}

// Resposta de `lab-reserve`: a ÚNICA mensagem que carrega a senha do aluno. Devolve
// null quando algo não tem a forma esperada (a senha vem do serviço, nunca é
// inventada nem arrumada aqui).
function credentialsPayload(input) {
  if (!isPlainObject(input)) return null;
  const reservationId = cleanReservationId(input.reservationId);
  const account = cleanAccount(input.account);
  const userName = cleanText(input.userName, 80);
  const { password } = input;
  const passwordOk =
    typeof password === 'string' && password.length >= 8 && /^[\x21-\x7e]{8,64}$/.test(password);
  if (!reservationId || !account || !userName || !passwordOk) return null;
  return {
    reservationId,
    account,
    userName,
    password,
    startBy: cleanCount(input.startBy),
    endsAt: cleanCount(input.endsAt),
  };
}

function extendPayload(input) {
  if (!isPlainObject(input)) return null;
  const reservationId = cleanReservationId(input.reservationId);
  if (!reservationId) return null;
  return { reservationId, endsAt: cleanCount(input.endsAt) };
}

// Resposta de `lab-events`: só eventos v2 válidos (o gerente confere de novo ao receber) e que
// caibam no limite da resposta. `lastSeq` e `firstSeq` dizem até onde o diário vai e de onde ele
// ainda tem (o que ficou antes foi apagado pela rotação ou pela retenção).
function eventsPayload(input, { maxBytes = 200 * 1024 } = {}) {
  const source = isPlainObject(input) ? input : {};
  const list = Array.isArray(source.events) ? source.events : [];
  const accepted = [];
  let size = 2;
  for (const raw of list) {
    const checked = events.validateEvent(raw);
    if (!checked.ok) continue;
    const bytes = Buffer.byteLength(JSON.stringify(checked.event), 'utf8') + 1;
    if (size + bytes > maxBytes) break;
    accepted.push(checked.event);
    size += bytes;
  }
  return {
    events: accepted,
    lastSeq: cleanCount(source.lastSeq),
    firstSeq: cleanCount(source.firstSeq),
  };
}

// Quem está com o PC, devolvido junto de uma recusa `busy`.
function busyPayload(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    account: cleanAccount(source.account),
    label: cleanText(source.label, 40),
    state: cleanChoice(source.state, RESERVATION_STATES, 'reserved'),
    endsAt: cleanCount(source.endsAt),
  };
}

module.exports = {
  ERROR_CODES,
  FILE_SESSION,
  IMPLEMENTED_TYPES,
  LAB_PROTOCOL,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_FIELDS,
  buildError,
  buildRequest,
  buildSuccess,
  busyPayload,
  credentialsPayload,
  eventsPayload,
  extendPayload,
  parseRequest,
  parseResponse,
  serializeResponse,
  statusPayload,
  studentPayload,
  studentsPayload,
};
