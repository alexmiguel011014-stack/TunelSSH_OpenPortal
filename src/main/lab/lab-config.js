'use strict';

// Regras puras do modo laboratório sobre o config.json (GOALS 16): quem manda
// em cada chave, as uniões de autorização e a lista de PCs do gerente. Sem
// Electron nem disco — config-manager.js liga isto ao arquivo (lab-store.js).
//
//   hostId            só o main cria; o renderer não altera
//   lab.managers      só a matrícula aceita e "Remover gerente" (locais)
//   lab.managed       derivado de lab.managers
//   lab.mode          o renderer (Configurações → "Modo laboratório")
//   lab.roster        só o main (matrícula e "Remover" da tela Laboratório)

const MAX_MANAGERS = 20;
const MAX_ROSTER = 50;
// Quantos dias o registro de acessos guarda (GOALS 19).
const DEFAULT_LOG_RETENTION_DAYS = 180;
const MIN_LOG_RETENTION_DAYS = 1;
const MAX_LOG_RETENTION_DAYS = 3650;

function clampRetentionDays(value) {
  if (!Number.isFinite(value)) return DEFAULT_LOG_RETENTION_DAYS;
  return Math.min(MAX_LOG_RETENTION_DAYS, Math.max(MIN_LOG_RETENTION_DAYS, Math.round(value)));
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return [...value.replace(CONTROL_CHARS, ' ').trim()].slice(0, max).join('');
}

// Login Tailscale (e-mail). Mantido exatamente como o `tailscale whois`
// devolve; só recusa o que não pode ser um login.
function normalizeLogin(value) {
  const login = cleanText(value, 200);
  if (!login || /\s/.test(login) || login === 'unknown') return '';
  return login;
}

function isIpv4(value) {
  const match = IPV4.exec(value);
  return Boolean(match) && match.slice(1).every((part) => Number(part) <= 255);
}

function sanitizeRosterEntry(entry) {
  if (!isObject(entry)) return null;
  const hostId = cleanText(entry.hostId, 64);
  const host = typeof entry.host === 'string' ? entry.host.trim() : '';
  if (!hostId || !isIpv4(host)) return null;
  return {
    hostId,
    name: cleanText(entry.name, 100) || host,
    host,
    enrolledAt: Number.isSafeInteger(entry.enrolledAt) ? entry.enrolledAt : 0,
  };
}

function sanitizeManagers(list) {
  const managers = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const login = normalizeLogin(raw);
    if (login && !managers.includes(login)) managers.push(login);
    if (managers.length >= MAX_MANAGERS) break;
  }
  return managers;
}

function sanitizeRoster(list) {
  const roster = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = sanitizeRosterEntry(raw);
    if (entry && !roster.some((item) => item.hostId === entry.hostId)) roster.push(entry);
    if (roster.length >= MAX_ROSTER) break;
  }
  return roster;
}

// Estado do modo laboratório lido do config guardado, sempre normalizado.
function readLab(config) {
  const lab = isObject(config?.lab) ? config.lab : {};
  const managers = sanitizeManagers(lab.managers);
  return {
    managers,
    managed: managers.length > 0,
    mode: lab.mode === true,
    roster: sanitizeRoster(lab.roster),
    logRetentionDays: clampRetentionDays(lab.logRetentionDays),
  };
}

// O que vai para o disco: só as chaves que existem de verdade (`managed` é
// derivado e não se guarda).
function toStoredLab(lab) {
  return {
    mode: lab.mode,
    managers: lab.managers,
    roster: lab.roster,
    logRetentionDays: lab.logRetentionDays,
  };
}

// O renderer só pode mudar `lab.mode`. Tudo o mais vem do que já está no disco,
// qualquer que seja o objeto que ele mande (é o que impede um saveConfig de
// adicionar um gerente).
function mergeLabFromRenderer(existingLab, incomingLab) {
  const current = readLab({ lab: existingLab });
  const mode =
    isObject(incomingLab) && typeof incomingLab.mode === 'boolean'
      ? incomingLab.mode
      : current.mode;
  return toStoredLab({ ...current, mode });
}

// Aplicado por writeConfig depois de juntar o que o renderer mandou ao config
// existente: `hostId` e `lab` nunca saem de lá.
function guardLabKeys(existing, candidate) {
  const out = { ...candidate };
  if (existing?.hostId) out.hostId = existing.hostId;
  else delete out.hostId;
  if (existing?.lab === undefined && candidate.lab === undefined) delete out.lab;
  else out.lab = mergeLabFromRenderer(existing?.lab, candidate.lab);
  return out;
}

function addManager(config, login) {
  const clean = normalizeLogin(login);
  const lab = readLab(config);
  if (!clean) return { ok: false, error: 'invalid', lab };
  if (lab.managers.includes(clean)) return { ok: true, added: false, lab };
  if (lab.managers.length >= MAX_MANAGERS) return { ok: false, error: 'full', lab };
  const next = { ...lab, managers: [...lab.managers, clean], managed: true };
  return { ok: true, added: true, lab: next };
}

function removeManager(config, login) {
  const lab = readLab(config);
  const managers = lab.managers.filter((item) => item !== login);
  return {
    removed: managers.length !== lab.managers.length,
    lab: { ...lab, managers, managed: managers.length > 0 },
  };
}

// Inclui ou atualiza (mesmo hostId) um PC da lista do gerente.
function upsertRosterEntry(config, entry) {
  const clean = sanitizeRosterEntry(entry);
  const lab = readLab(config);
  if (!clean) return { ok: false, error: 'invalid', lab };
  const index = lab.roster.findIndex((item) => item.hostId === clean.hostId);
  if (index >= 0) {
    const roster = lab.roster.map((item, i) =>
      i === index ? { ...clean, enrolledAt: item.enrolledAt || clean.enrolledAt } : item,
    );
    return { ok: true, added: false, lab: { ...lab, roster } };
  }
  if (lab.roster.length >= MAX_ROSTER) return { ok: false, error: 'full', lab };
  return {
    ok: true,
    added: true,
    lab: { ...lab, roster: [...lab.roster, clean] },
  };
}

function removeRosterEntry(config, hostId) {
  const lab = readLab(config);
  const roster = lab.roster.filter((item) => item.hostId !== hostId);
  return {
    removed: roster.length !== lab.roster.length,
    lab: { ...lab, roster },
  };
}

function unique(list) {
  return [...new Set(list)];
}

// Quem este PC aprova sem diálogo: a lista do dono mais os gerentes.
function effectiveAllowedUsers(config) {
  const own = Array.isArray(config?.allowedUsers) ? config.allowedUsers : [];
  return unique([...own, ...readLab(config).managers]);
}

// Para quem este PC envia o resumo das sessões: a lista do dono mais os gerentes.
function effectiveReportTo(config) {
  const own = Array.isArray(config?.reportTo) ? config.reportTo : [];
  return unique([...own, ...readLab(config).managers]);
}

// O modo laboratório vale neste PC quando ele é gerenciado ou a tela foi ligada.
function isLabModeOn(config) {
  const lab = readLab(config);
  return lab.mode || lab.managed;
}

module.exports = {
  DEFAULT_LOG_RETENTION_DAYS,
  MAX_LOG_RETENTION_DAYS,
  MIN_LOG_RETENTION_DAYS,
  MAX_MANAGERS,
  MAX_ROSTER,
  addManager,
  clampRetentionDays,
  effectiveAllowedUsers,
  effectiveReportTo,
  guardLabKeys,
  isIpv4,
  isLabModeOn,
  mergeLabFromRenderer,
  normalizeLogin,
  readLab,
  removeManager,
  removeRosterEntry,
  sanitizeRosterEntry,
  toStoredLab,
  upsertRosterEntry,
};
