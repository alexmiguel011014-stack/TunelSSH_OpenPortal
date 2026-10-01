'use strict';

// Lado do PC gerenciado (GOALS 16): recebe as mensagens `lab-*` que o
// ConnectionRequestServer entrega com o endereço REAL do socket, descobre quem
// é pelo `tailscale whois`, e só atende quem está em `lab.managers` — a única
// exceção é `lab-enroll`, que pede o clique da pessoa que está no PC.
//
// Tudo que toca o sistema (whois, diálogo, disco, relógio) entra por `deps`,
// para o teste rodar sem Tailscale, sem Electron e sem rede.

const protocol = require('./protocol');

const IDENTITY_TTL_MS = 60 * 1000;
const UNKNOWN_IDENTITY_TTL_MS = 5 * 1000;
const IDENTITY_CACHE_MAX = 256;
const ENROLL_DIALOG_MS = 60 * 1000;

function normalizeIp(address) {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function createLabHost(deps) {
  const {
    resolveIdentity,
    limiter,
    store,
    askEnrollment,
    info,
    getStatusInput = () => ({}),
    onEnrolled = () => {},
    log = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    enrollDialogMs = ENROLL_DIALOG_MS,
  } = deps;

  const identityCache = new Map(); // ip -> { login, expiresAt }
  let enrollmentOpen = false;

  async function identityOf(ip) {
    const cached = identityCache.get(ip);
    if (cached && cached.expiresAt > now()) return cached.login;
    let login = 'unknown';
    try {
      login = (await resolveIdentity(ip)) || 'unknown';
    } catch {
      login = 'unknown';
    }
    if (identityCache.size >= IDENTITY_CACHE_MAX) {
      identityCache.delete(identityCache.keys().next().value);
    }
    const ttl = login === 'unknown' ? UNKNOWN_IDENTITY_TTL_MS : IDENTITY_TTL_MS;
    identityCache.set(ip, { login, expiresAt: now() + ttl });
    return login;
  }

  // Recusa por falta de autorização: conta para o bloqueio do IP.
  function refuse(type, ip, message) {
    const verdict = limiter.fail(ip);
    log(`recusado ${type} de ${ip}: ${verdict === 'locked' ? 'IP bloqueado' : 'não autorizado'}`);
    return protocol.buildError(
      type,
      verdict === 'locked' ? 'locked' : 'unauthorized',
      verdict === 'locked' ? 'Muitos pedidos recusados: aguarde alguns minutos' : message,
    );
  }

  function hostIdentity() {
    return {
      hostId: store.getHostId(),
      hostName: info.hostName(),
      appVersion: info.appVersion(),
    };
  }

  async function status() {
    // O serviço pode estar parado ou lento: isso nunca impede o PC de responder.
    let fromService = {};
    try {
      fromService = (await getStatusInput()) || {};
    } catch {}
    // Lista de permitidos: o que o serviço/GOALS 18 devolver além disto não passa.
    const payload = protocol.statusPayload({
      ...fromService,
      ...hostIdentity(),
      managed: store.getLab().managed,
    });
    return protocol.buildSuccess('lab-status', payload);
  }

  async function enroll(ip, login, signal) {
    if (login === 'unknown') {
      return refuse(
        'lab-enroll',
        ip,
        'Não foi possível confirmar quem você é no Tailscale; entre no Tailscale e tente de novo',
      );
    }
    if (store.getLab().managers.includes(login)) {
      limiter.reset(ip);
      return protocol.buildSuccess('lab-enroll', {
        accepted: true,
        ...hostIdentity(),
      });
    }
    if (enrollmentOpen) {
      return protocol.buildError(
        'lab-enroll',
        'busy',
        'Há outro pedido para gerenciar este PC aberto; tente de novo em instantes',
      );
    }

    enrollmentOpen = true;
    const dialog = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      dialog.abort();
    }, enrollDialogMs);
    const abandon = () => dialog.abort();
    signal?.addEventListener('abort', abandon, { once: true });
    if (signal?.aborted) abandon();

    let answer = 'rejected';
    try {
      answer = await askEnrollment({
        login,
        remoteAddress: ip,
        signal: dialog.signal,
      });
    } catch {
      answer = 'rejected';
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', abandon);
      enrollmentOpen = false;
    }

    if (signal?.aborted) {
      log(`matrícula de ${login} abandonada por quem pediu`);
      return null;
    }
    if (timedOut) {
      log(`matrícula de ${login} sem resposta em ${enrollDialogMs / 1000}s`);
      return protocol.buildSuccess('lab-enroll', {
        accepted: false,
        reason: 'timeout',
      });
    }
    if (answer !== 'accepted') {
      limiter.fail(ip);
      log(`matrícula de ${login} recusada pelo dono do PC`);
      return protocol.buildSuccess('lab-enroll', {
        accepted: false,
        reason: 'rejected',
      });
    }
    const added = store.addManager(login);
    if (!added.ok) {
      log(`matrícula de ${login} não gravada: ${added.error}`);
      return protocol.buildError('lab-enroll', 'internal', 'Não foi possível gravar o gerente');
    }
    limiter.reset(ip);
    log(`${login} agora gerencia este PC`);
    try {
      onEnrolled(login);
    } catch {}
    return protocol.buildSuccess('lab-enroll', {
      accepted: true,
      ...hostIdentity(),
    });
  }

  // `input`: o pedido cru (Buffer/texto) como veio da rede; `remoteAddress`: o
  // endereço do socket; `signal`: aborta se quem pediu desistir. Devolve a
  // resposta (objeto) ou null quando não há mais para quem responder. Nunca lança.
  async function handle({ input, remoteAddress, signal }) {
    const ip = normalizeIp(remoteAddress);
    try {
      if (!ip) return protocol.buildError(undefined, 'unauthorized', 'Origem desconhecida');
      if (limiter.isLocked(ip)) {
        return protocol.buildError(
          undefined,
          'locked',
          'Muitos pedidos recusados: aguarde alguns minutos',
        );
      }
      const parsed = protocol.parseRequest(input);
      if (!parsed.ok) return protocol.buildError(undefined, parsed.error, parsed.message);
      const { request } = parsed;

      const login = await identityOf(ip);
      if (signal?.aborted) return null;

      if (request.type === 'lab-enroll') return await enroll(ip, login, signal);

      if (!store.getLab().managers.includes(login)) {
        return refuse(request.type, ip, 'Este PC não aceita você como gerente');
      }
      limiter.reset(ip);
      if (!protocol.IMPLEMENTED_TYPES.has(request.type)) {
        return protocol.buildError(
          request.type,
          'unsupported',
          'Recurso ainda não disponível neste PC',
        );
      }
      if (request.type === 'lab-status') return await status();
      return protocol.buildError(
        request.type,
        'unsupported',
        'Recurso ainda não disponível neste PC',
      );
    } catch (err) {
      log(`erro ao atender ${ip}: ${err?.message || err}`);
      return protocol.buildError(undefined, 'internal', 'Falha ao atender o pedido');
    }
  }

  return { handle };
}

module.exports = { createLabHost, normalizeIp, ENROLL_DIALOG_MS };
