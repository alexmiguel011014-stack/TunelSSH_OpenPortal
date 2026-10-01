'use strict';

// Lado do gerente (GOALS 16): a lista de PCs de laboratório (lab.roster), a
// matrícula de um PC novo e a consulta periódica de `lab-status`. O status é
// CONSULTADO (a cada 10 s), não empurrado: a resposta do próprio PC é a
// verdade, e uma resposta que não vem também é informação.
//
// Estados de um PC na tela: 'checking' (ainda não respondeu), 'free',
// 'reserved', 'in-use', 'offline' (2 consultas sem resposta), 'incompatible'
// (outra versão do protocolo) e 'refused' (o PC não reconhece mais este gerente).

const protocol = require('./protocol');

const POLL_INTERVAL_MS = 10 * 1000;
const POLL_TIMEOUT_MS = 3 * 1000;
const ENROLL_TIMEOUT_MS = 70 * 1000; // o diálogo no PC fecha sozinho em 60 s
const MAX_PARALLEL = 8;
const MISSES_UNTIL_OFFLINE = 2;

async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(runners);
}

const ENROLL_ERRORS = {
  unreachable: 'Não foi possível contactar o PC; confira o IP e se o OpenPortal está aberto lá',
  timeout: 'O PC não respondeu a tempo; confira o IP e se o OpenPortal está aberto lá',
  'bad-response': 'O PC respondeu algo que este app não entende',
  unauthorized: 'O PC não confirmou o seu login do Tailscale; entre no Tailscale e tente de novo',
  locked: 'O PC bloqueou este endereço por pedidos recusados; aguarde alguns minutos',
  busy: 'Já há um pedido aberto nesse PC; tente de novo em instantes',
  unsupported: 'O OpenPortal desse PC tem uma versão do modo laboratório diferente da deste app',
  internal: 'O PC não conseguiu concluir o pedido',
  'bad-request': 'O pedido de matrícula foi recusado pelo PC',
};

function createLabManager({
  store,
  sendRequest,
  isAllowedHost,
  now = Date.now,
  onChange = () => {},
  setTimer = setInterval,
  clearTimer = clearInterval,
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
  enrollTimeoutMs = ENROLL_TIMEOUT_MS,
  maxParallel = MAX_PARALLEL,
  log = () => {},
}) {
  // hostId -> { state, missed, status, lastSeenAt, error }
  const live = new Map();
  let timer = null;
  let inFlight = null;
  let lastSignature = '[]';

  function snapshot() {
    return store.getLab().roster.map((entry) => {
      const info = live.get(entry.hostId) || { state: 'checking', missed: 0 };
      const status = info.status || {};
      return {
        hostId: entry.hostId,
        name: status.hostName || entry.name,
        host: entry.host,
        enrolledAt: entry.enrolledAt,
        state: info.state,
        appVersion: status.appVersion || '',
        studentCount: status.studentCount || 0,
        ...(status.student ? { student: status.student } : {}),
        service: status.service || { installed: false, running: false },
        ...(status.disk ? { disk: status.disk } : {}),
        lastSeenAt: info.lastSeenAt || 0,
        ...(info.error ? { error: info.error } : {}),
      };
    });
  }

  // Avisa o renderer só quando algo que a tela mostra mudou (o horário da
  // última resposta não conta, senão cada consulta seria um aviso).
  function emitIfChanged() {
    const current = snapshot();
    const signature = JSON.stringify(
      current.map((entry) => {
        const shown = { ...entry };
        delete shown.lastSeenAt;
        return shown;
      }),
    );
    if (signature === lastSignature) return;
    lastSignature = signature;
    onChange(current);
  }

  function applyStatusResponse(entry, response) {
    const previous = live.get(entry.hostId) || { missed: 0 };
    if (response.labProtocol !== protocol.LAB_PROTOCOL) {
      live.set(entry.hostId, {
        ...previous,
        state: 'incompatible',
        missed: 0,
        status: null,
      });
      return;
    }
    const status = protocol.statusPayload(response);
    // O endereço passou a ser de outro PC (IP reaproveitado): não é o que foi matriculado.
    if (status.hostId !== entry.hostId) {
      live.set(entry.hostId, {
        ...previous,
        state: 'offline',
        missed: 0,
        status: null,
        error: 'host-mismatch',
      });
      return;
    }
    live.set(entry.hostId, {
      state: status.state,
      missed: 0,
      status,
      lastSeenAt: now(),
    });
  }

  function applyFailure(entry, result) {
    const previous = live.get(entry.hostId) || { state: 'checking', missed: 0 };
    if (result.ok && !result.response.ok) {
      const code = result.response.error;
      if (code === 'unauthorized' || code === 'locked') {
        live.set(entry.hostId, {
          ...previous,
          state: 'refused',
          missed: 0,
          status: null,
          error: code,
        });
        return;
      }
      if (code === 'unsupported') {
        live.set(entry.hostId, {
          ...previous,
          state: 'incompatible',
          missed: 0,
          status: null,
        });
        return;
      }
    }
    const missed = previous.missed + 1;
    const state = missed >= MISSES_UNTIL_OFFLINE ? 'offline' : previous.state;
    live.set(entry.hostId, { ...previous, state, missed, error: undefined });
  }

  async function pollEntry(entry) {
    const built = protocol.buildRequest('lab-status');
    const result = await sendRequest(entry.host, built, {
      timeoutMs: pollTimeoutMs,
    });
    if (result.ok && result.response.ok) applyStatusResponse(entry, result.response);
    else applyFailure(entry, result);
  }

  async function runRound() {
    const roster = store.getLab().roster;
    const ids = new Set(roster.map((entry) => entry.hostId));
    for (const hostId of live.keys()) if (!ids.has(hostId)) live.delete(hostId);
    await runPool(roster, maxParallel, (entry) =>
      pollEntry(entry).catch((err) =>
        log(`consulta de ${entry.host} falhou: ${err?.message || err}`),
      ),
    );
    emitIfChanged();
  }

  // Duas rodadas nunca correm juntas: quem pede durante uma rodada espera por ela.
  function pollOnce() {
    if (!inFlight) {
      inFlight = runRound().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function start() {
    if (timer) return;
    timer = setTimer(() => {
      pollOnce().catch(() => {});
    }, pollIntervalMs);
    timer.unref?.();
    pollOnce().catch(() => {});
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  async function enroll(host) {
    const address = typeof host === 'string' ? host.trim() : '';
    if (!address || !isAllowedHost(address)) {
      return {
        ok: false,
        error: 'bad-host',
        message: 'Use o IP Tailscale do PC, no formato 100.x.x.x',
      };
    }
    const built = protocol.buildRequest('lab-enroll');
    const result = await sendRequest(address, built, {
      timeoutMs: enrollTimeoutMs,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        message: ENROLL_ERRORS[result.error] || result.message,
      };
    }
    const { response } = result;
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        message: ENROLL_ERRORS[response.error] || response.message,
      };
    }
    if (response.accepted !== true) {
      return {
        ok: false,
        error: response.reason === 'timeout' ? 'timeout' : 'rejected',
        message:
          response.reason === 'timeout'
            ? 'Ninguém respondeu no PC a tempo; peça para clicar em Aceitar e tente de novo'
            : 'A pessoa no PC recusou o pedido',
      };
    }
    const stored = store.upsertRosterEntry({
      hostId: response.hostId,
      name: response.hostName,
      host: address,
      enrolledAt: now(),
    });
    if (!stored.ok) {
      return {
        ok: false,
        error: stored.error,
        message:
          stored.error === 'full'
            ? 'A lista já tem 50 PCs; remova algum antes de adicionar outro'
            : 'O PC respondeu com dados inválidos',
      };
    }
    log(`PC ${response.hostName} (${address}) matriculado`);
    live.delete(response.hostId);
    emitIfChanged();
    pollOnce().catch(() => {});
    const entry = snapshot().find((item) => item.hostId === response.hostId);
    return { ok: true, entry, added: stored.added };
  }

  function remove(hostId) {
    const result = store.removeRosterEntry(hostId);
    live.delete(hostId);
    emitIfChanged();
    return { ok: result.removed };
  }

  return { enroll, remove, pollOnce, snapshot, start, stop };
}

module.exports = {
  createLabManager,
  ENROLL_TIMEOUT_MS,
  MAX_PARALLEL,
  MISSES_UNTIL_OFFLINE,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
};
