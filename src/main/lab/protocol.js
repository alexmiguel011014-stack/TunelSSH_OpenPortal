'use strict';

// Protocolo `lab-*` do modo laboratório (GOALS 16–19), na mesma porta de
// sinalização (18902) do connect-request: um objeto JSON por conexão. A
// especificação está em docs/ARQUITETURA_CONEXAO.md ("Modo laboratório"); este
// módulo só monta, lê e valida as mensagens — sem rede, sem Electron, sem
// exceções para entrada ruim (a porta é alcançável por qualquer peer).

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
const IMPLEMENTED_TYPES = Object.freeze(new Set(['lab-enroll', 'lab-status']));

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

function buildError(requestType, error, message) {
  const code = ERROR_CODES.includes(error) ? error : 'internal';
  return {
    type: 'lab-response',
    request: requestType,
    ok: false,
    error: code,
    ...(message ? { message: String(message) } : {}),
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

module.exports = {
  ERROR_CODES,
  IMPLEMENTED_TYPES,
  LAB_PROTOCOL,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_FIELDS,
  buildError,
  buildRequest,
  buildSuccess,
  parseRequest,
  parseResponse,
  serializeResponse,
  statusPayload,
};
