'use strict';

// O registro central de acessos do gerente (GOALS 19): `userData/lab-log.jsonl`, uma linha por
// evento recebido dos PCs de laboratório (por push ou por consulta de sequência), com índice em
// memória por aluno, PC e data. Mescla de forma idempotente em (hostId, seq), guarda o ponto até
// onde a sequência de cada PC está completa (o "cursor"), registra as lacunas que a rotação ou a
// retenção do diário de um PC deixaram, aplica a retenção e exporta CSV.
//
// O disco entra por `fsApi`, o relógio por `now`: o teste roda sem arquivo de verdade.

const fs = require('fs');
const path = require('path');
const events = require('./events');

const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_GAP_SPAN = 1_000_000;

function clampDays(days) {
  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(days)));
}

// Sem arquivo (os testes do resto do app): o registro vale só enquanto o app está aberto.
function createMemoryFs() {
  const state = { text: undefined, tmp: '' };
  return {
    existsSync: () => state.text !== undefined,
    readFileSync: () => state.text ?? '',
    appendFileSync: (_file, text) => {
      state.text = (state.text ?? '') + text;
    },
    writeFileSync: (_file, text) => {
      state.tmp = text;
    },
    renameSync: () => {
      state.text = state.tmp;
    },
    mkdirSync: () => {},
  };
}

function createEventLog({
  file = null,
  fsApi = file ? fs : createMemoryFs(),
  now = Date.now,
  retentionDays = DEFAULT_RETENTION_DAYS,
  onChange = () => {},
  log = () => {},
}) {
  // { event, receivedAt }, na ordem em que chegaram.
  let items = [];
  // Lacunas: { hostId, hostName, fromSeq, toSeq, reason, receivedAt }.
  let gaps = [];
  const keys = new Set();
  // Por PC: as sequências que temos, as lacunas já registradas e o cursor salvo.
  const hosts = new Map(); // hostId -> { present:Set<number>, base:number, cursor:number }
  let days = clampDays(retentionDays);

  function hostState(hostId) {
    let state = hosts.get(hostId);
    if (!state) {
      state = { present: new Set(), base: 0, cursor: 0, ranges: [] };
      hosts.set(hostId, state);
    }
    return state;
  }

  function covered(state, seq) {
    return state.present.has(seq) || state.ranges.some(([from, to]) => seq >= from && seq <= to);
  }

  // O cursor é o maior N tal que de `base` até N cada número ou existe ou está numa lacuna
  // registrada: tudo até ele já foi tratado, e o resto precisa ser pedido ao PC.
  function advance(state) {
    let next = Math.max(state.cursor, state.base);
    while (covered(state, next + 1)) next += 1;
    state.cursor = next;
  }

  function keyOf(event) {
    return event.seq >= 1
      ? `${event.hostId}:${event.seq}`
      : `${event.hostId}:local:${event.type}:${event.at}`;
  }

  const filePath = file || 'lab-log.jsonl';

  function appendLine(entry) {
    try {
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
      fsApi.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    } catch (err) {
      log(`registro de acessos: não gravei no disco (${err.message})`);
      return false;
    }
  }

  function remember(entry) {
    if (entry.kind === 'event') {
      const { event, receivedAt } = entry;
      keys.add(keyOf(event));
      items.push({ event, receivedAt });
      if (event.seq >= 1) {
        const state = hostState(event.hostId);
        state.present.add(event.seq);
        advance(state);
      }
    } else if (entry.kind === 'gap') {
      keys.add(`${entry.hostId}:gap:${entry.fromSeq}:${entry.toSeq}`);
      gaps.push(entry);
      const state = hostState(entry.hostId);
      state.ranges.push([entry.fromSeq, entry.toSeq]);
      advance(state);
    } else if (entry.kind === 'cursor') {
      const state = hostState(entry.hostId);
      state.base = Math.max(state.base, entry.seq);
      advance(state);
    }
  }

  // Lê uma linha do arquivo; devolve a entrada boa ou null (linha quebrada, de outra versão...).
  function parseLine(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'event') {
      const checked = events.validateEvent(raw.event, { local: true });
      if (!checked.ok) return null;
      return {
        kind: 'event',
        event: checked.event,
        receivedAt: Number.isSafeInteger(raw.receivedAt) ? raw.receivedAt : checked.event.at,
      };
    }
    if (raw.kind === 'gap') {
      if (
        typeof raw.hostId !== 'string' ||
        !Number.isSafeInteger(raw.fromSeq) ||
        !Number.isSafeInteger(raw.toSeq) ||
        raw.fromSeq < 0 ||
        raw.toSeq < raw.fromSeq ||
        raw.toSeq - raw.fromSeq > MAX_GAP_SPAN
      ) {
        return null;
      }
      return {
        kind: 'gap',
        hostId: raw.hostId,
        hostName: typeof raw.hostName === 'string' ? raw.hostName.slice(0, 100) : '',
        fromSeq: raw.fromSeq,
        toSeq: raw.toSeq,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 20) : 'missing',
        receivedAt: Number.isSafeInteger(raw.receivedAt) ? raw.receivedAt : 0,
      };
    }
    if (raw.kind === 'cursor') {
      if (typeof raw.hostId !== 'string' || !Number.isSafeInteger(raw.seq) || raw.seq < 0)
        return null;
      return { kind: 'cursor', hostId: raw.hostId, seq: raw.seq };
    }
    return null;
  }

  function load() {
    items = [];
    gaps = [];
    keys.clear();
    hosts.clear();
    let text = '';
    try {
      if (fsApi.existsSync(filePath)) text = fsApi.readFileSync(filePath, 'utf8');
    } catch (err) {
      log(`registro de acessos: não consegui ler (${err.message})`);
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry) remember(entry);
    }
  }

  // Um evento novo. Devolve { added } (false quando já tínhamos esse (hostId, seq)).
  function add(event, receivedAt = now()) {
    const checked = events.validateEvent(event, { local: true });
    if (!checked.ok) return { added: false, error: checked.error };
    const clean = checked.event;
    if (keys.has(keyOf(clean))) return { added: false, duplicate: true };
    const entry = { kind: 'event', event: clean, receivedAt };
    remember(entry);
    appendLine(entry);
    onChange();
    return { added: true };
  }

  // Um intervalo de números que o PC não tem mais (rotação, retenção do diário do PC).
  function addGap({ hostId, hostName = '', fromSeq, toSeq, reason = 'missing' }) {
    if (
      typeof hostId !== 'string' ||
      !hostId ||
      !Number.isSafeInteger(fromSeq) ||
      !Number.isSafeInteger(toSeq) ||
      fromSeq < 1 ||
      toSeq < fromSeq ||
      toSeq - fromSeq > MAX_GAP_SPAN
    ) {
      return false;
    }
    const key = `${hostId}:gap:${fromSeq}:${toSeq}`;
    if (keys.has(key)) return false;
    keys.add(key);
    const entry = {
      kind: 'gap',
      hostId,
      hostName: String(hostName).slice(0, 100),
      fromSeq,
      toSeq,
      reason: String(reason).slice(0, 20),
      receivedAt: now(),
    };
    remember(entry);
    appendLine(entry);
    onChange();
    return true;
  }

  // Até onde a sequência deste PC está completa: pedir ao PC a partir daqui.
  function cursor(hostId) {
    const state = hosts.get(hostId);
    return state ? state.cursor : 0;
  }

  // Grava o cursor atual de cada PC (depois de uma rodada de consulta e antes da retenção): é o que
  // permite apagar eventos velhos sem que a sequência pareça incompleta.
  function saveCursors() {
    for (const [hostId, state] of hosts) {
      if (state.cursor > state.base) {
        state.base = state.cursor;
        appendLine({ kind: 'cursor', hostId, seq: state.cursor });
      }
    }
  }

  function matches(item, filters) {
    const { event } = item;
    if (filters.hostId && event.hostId !== filters.hostId) return false;
    if (filters.types && filters.types.length > 0 && !filters.types.includes(event.type))
      return false;
    if (Number.isFinite(filters.from) && event.at < filters.from) return false;
    if (Number.isFinite(filters.to) && event.at > filters.to) return false;
    if (filters.student) {
      const wanted = String(filters.student).trim().toLowerCase();
      const account = (event.student?.account || '').toLowerCase();
      const label = (event.student?.label || '').toLowerCase();
      if (wanted && account !== wanted && !label.includes(wanted)) return false;
    }
    return true;
  }

  // Eventos que passam nos filtros (aluno por conta ou parte do nome, PC, período, tipos), do mais
  // antigo ao mais novo, mais as lacunas dos PCs consultados.
  function query(filters = {}) {
    const selected = items
      .filter((item) => matches(item, filters))
      .sort((a, b) => a.event.at - b.event.at || a.event.seq - b.event.seq)
      .map((item) => ({ ...item.event, receivedAt: item.receivedAt }));
    const shownGaps = gaps
      .filter((gap) => !filters.hostId || gap.hostId === filters.hostId)
      .map((gap) => ({ ...gap }));
    return { events: selected, gaps: shownGaps };
  }

  // Os PCs e alunos que aparecem no registro, para montar os filtros da tela.
  function facets() {
    const pcs = new Map();
    const students = new Map();
    for (const { event } of items) {
      if (event.hostName || !pcs.has(event.hostId))
        pcs.set(event.hostId, event.hostName || event.hostId);
      if (event.student?.account) {
        students.set(event.student.account, event.student.label || event.student.account);
      }
    }
    return {
      hosts: [...pcs].map(([hostId, hostName]) => ({ hostId, hostName })),
      students: [...students].map(([account, label]) => ({ account, label })),
    };
  }

  function rewrite(keptItems, keptGaps) {
    const lines = [];
    for (const [hostId, state] of hosts) {
      lines.push(
        JSON.stringify({ kind: 'cursor', hostId, seq: Math.max(state.base, state.cursor) }),
      );
    }
    for (const gap of keptGaps) lines.push(JSON.stringify(gap));
    for (const item of keptItems) {
      lines.push(JSON.stringify({ kind: 'event', event: item.event, receivedAt: item.receivedAt }));
    }
    const tmp = `${filePath}.tmp`;
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
    fsApi.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    fsApi.renameSync(tmp, filePath);
  }

  // Retenção: apaga o que é mais velho que `retention` dias. O cursor de cada PC é gravado antes, para
  // a sequência não parecer incompleta; um PC sem nenhum evento recente mantém seu último evento.
  function applyRetention(retention = days) {
    const cutoff = now() - clampDays(retention) * DAY_MS;
    saveCursors();
    const newestPerHost = new Map();
    for (const item of items) {
      const best = newestPerHost.get(item.event.hostId);
      if (!best || item.event.at > best.event.at) newestPerHost.set(item.event.hostId, item);
    }
    const keptItems = items.filter(
      (item) => item.event.at >= cutoff || newestPerHost.get(item.event.hostId) === item,
    );
    const keptGaps = gaps.filter((gap) => !gap.receivedAt || gap.receivedAt >= cutoff);
    const removed = items.length - keptItems.length + (gaps.length - keptGaps.length);
    if (removed === 0) return 0;
    try {
      rewrite(keptItems, keptGaps);
    } catch (err) {
      log(`registro de acessos: retenção não gravada (${err.message})`);
      return 0;
    }
    const cursors = [...hosts].map(([hostId, state]) => [
      hostId,
      Math.max(state.base, state.cursor),
    ]);
    items = [];
    gaps = [];
    keys.clear();
    hosts.clear();
    for (const [hostId, seq] of cursors) remember({ kind: 'cursor', hostId, seq });
    for (const item of keptItems)
      remember({ kind: 'event', event: item.event, receivedAt: item.receivedAt });
    for (const gap of keptGaps) remember(gap);
    log(`registro de acessos: ${removed} registro(s) antigos apagados`);
    onChange();
    return removed;
  }

  function exportCsv(filters = {}, options = {}) {
    const { events: selected } = query(filters);
    return events.buildCsv(selected, {
      timeZone: options.timeZone,
      receivedAt: (event) => event.receivedAt || 0,
    });
  }

  function setRetentionDays(value) {
    days = clampDays(value);
    return days;
  }

  load();

  return {
    add,
    addGap,
    applyRetention,
    count: () => items.length,
    cursor,
    exportCsv,
    facets,
    getRetentionDays: () => days,
    query,
    saveCursors,
    setRetentionDays,
  };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  createEventLog,
};
