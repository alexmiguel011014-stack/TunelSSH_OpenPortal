'use strict';

// Quem pode empurrar um evento de atividade para este app (GOALS 19). A porta 18902 é alcançável por
// qualquer nó do Tailscale e o `activity-event` do GOALS 4 não pedia prova de nada: qualquer um podia
// plantar um registro. Agora:
//
//   - Um evento v2 só vale se vier do endereço de um PC da lista (`lab.roster`) E se o `hostId` do
//     evento for o daquele PC. O endereço é o do socket, não um campo da mensagem.
//   - Um evento antigo do GOALS 4 (sem `v`) só vale se o login do Tailscale de quem enviou (descoberto
//     por `tailscale whois` do endereço real) estiver nas listas de quem este app já conhece:
//     `reportTo` ou `allowedUsers`.
//   - Todo o resto é descartado, contado e anotado no registro (sem inundá-lo).
//
// Tudo que toca o sistema entra por parâmetro, para o teste rodar sem rede nem Electron.

const events = require('./events');

const LOG_EVERY_MS = 30 * 1000;
const LOG_KEYS_MAX = 200;

function createActivityReceiver({
  getRoster,
  getTrustedLogins,
  resolveIdentity,
  eventLog,
  onLegacy = () => {},
  log = () => {},
  now = Date.now,
}) {
  const stats = { accepted: 0, dropped: 0, reasons: {} };
  const lastLogged = new Map();

  function drop(reason, ip, detail = '') {
    stats.dropped += 1;
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    // Um registro por origem e motivo a cada 30 s: um atacante não enche o log.
    const key = `${ip}|${reason}`;
    const last = lastLogged.get(key);
    if (last === undefined || now() - last >= LOG_EVERY_MS) {
      if (lastLogged.size >= LOG_KEYS_MAX) lastLogged.delete(lastLogged.keys().next().value);
      lastLogged.set(key, now());
      log(
        `evento descartado de ${ip || 'origem desconhecida'}: ${reason}${detail ? ` (${detail})` : ''}`,
      );
    }
    return { accepted: false, reason };
  }

  function receiveV2(event, ip) {
    const checked = events.validateEvent(event);
    if (!checked.ok) return drop('malformed', ip, checked.error);
    const entry = (getRoster() || []).find((item) => item.host === ip);
    if (!entry) return drop('not-in-roster', ip);
    if (entry.hostId !== checked.event.hostId) {
      return drop('host-mismatch', ip, 'hostId diferente do PC matriculado nesse endereço');
    }
    const result = eventLog.add(checked.event, now());
    stats.accepted += 1;
    return { accepted: true, kind: 'v2', added: result.added === true };
  }

  async function receiveLegacy(event, ip) {
    const clean = events.normalizeLegacy(event);
    if (!clean) return drop('malformed', ip);
    let login = 'unknown';
    try {
      login = (await resolveIdentity(ip)) || 'unknown';
    } catch {
      login = 'unknown';
    }
    const trusted = getTrustedLogins() || [];
    if (login === 'unknown' || !trusted.includes(login)) {
      return drop('untrusted-sender', ip, login === 'unknown' ? 'login não confirmado' : login);
    }
    stats.accepted += 1;
    try {
      onLegacy(clean);
    } catch (err) {
      log(`evento do GOALS 4 não tratado: ${err.message}`);
    }
    return { accepted: true, kind: 'legacy' };
  }

  // Nunca lança: o chamador é o servidor da porta de sinalização.
  async function receive({ event, remoteAddress }) {
    const ip = events.normalizeIp(remoteAddress);
    try {
      if (!ip) return drop('no-origin', ip);
      const kind = events.classifyEvent(event);
      if (kind === 'v2') return receiveV2(event, ip);
      if (kind === 'legacy') return await receiveLegacy(event, ip);
      return drop('malformed', ip);
    } catch (err) {
      log(`erro ao receber evento de ${ip}: ${err?.message || err}`);
      return drop('error', ip);
    }
  }

  return { receive, stats: () => ({ ...stats, reasons: { ...stats.reasons } }) };
}

module.exports = { createActivityReceiver };
