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
// Com uma reserva em andamento, 3 consultas seguidas sem resposta (30 s) viram "PC sem resposta".
const MISSES_UNTIL_LOST = 3;
const ACTIVE_STATES = new Set(['reserved', 'in-use']);
// Quantas páginas de eventos buscar numa rodada de consulta, e o tamanho de cada uma.
const SYNC_MAX_ROUNDS = 12;
const SYNC_PAGE = 500;
const SYNC_TIMEOUT_MS = 8 * 1000;

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

// Quanto esperar cada ação: criar uma conta, apagar um perfil e encerrar uma sessão
// (aviso + logoff) levam bem mais que uma consulta.
const ACTION_TIMEOUTS = {
  'lab-students': 8_000,
  'lab-student-add': 70_000,
  'lab-student-quota': 40_000,
  'lab-student-delete': 130_000,
  'lab-reserve': 25_000,
  'lab-extend': 15_000,
  'lab-end': 100_000,
  'lab-folder': 135_000,
};

const ACTION_REFUSALS = {
  offline: 'Este PC não está respondendo',
  incompatible: 'Este PC tem uma versão do modo laboratório diferente da deste app',
  refused: 'Este PC não reconhece mais você como gerente',
  checking: 'Ainda estou consultando este PC; tente de novo em instantes',
};

const ACTION_ERRORS = {
  unreachable: 'Não foi possível contactar o PC; ele está ligado e com o OpenPortal aberto?',
  timeout:
    'O PC não respondeu a tempo; confira o estado dele antes de repetir (a ação pode ter sido feita)',
  'bad-response': 'O PC respondeu algo que este app não entende',
  unauthorized: 'Este PC não reconhece mais você como gerente',
  locked: 'O PC bloqueou este endereço por pedidos recusados; aguarde alguns minutos',
  unsupported: 'O OpenPortal desse PC tem uma versão do modo laboratório diferente da deste app',
  'service-down':
    'O serviço do laboratório não está rodando nesse PC; habilite o modo laboratório nas Configurações dele',
  'not-found': 'Não encontrei esse aluno ou reserva no PC; atualize a lista',
  'logoff-failed': 'Não consegui encerrar a sessão do aluno no PC',
  internal: 'O PC não conseguiu concluir o pedido',
  'bad-request': 'O PC recusou o pedido por ele estar mal formado',
};

const BAD_ANSWER = 'O PC respondeu algo que este app não entende';

function createLabManager({
  store,
  sendRequest,
  openFolder: openFolderRequest = async () => ({
    ok: false,
    error: 'unsupported',
    message: 'Ver pasta não está disponível neste app',
  }),
  adoptFileSession = () => {
    throw new Error('Sessão de arquivos indisponível');
  },
  isAllowedHost,
  eventLog = null,
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
        // Uma reserva em andamento e o PC não responde há 30 s (GOALS 19).
        ...(info.lost ? { lost: true } : {}),
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
      wasActive: ACTIVE_STATES.has(status.state),
    });
    if (previous.lost) recordLocal(entry, 'host-back', status, 'voltou a responder');
  }

  // Um fato que o PRÓPRIO gerente observa (o PC sumiu ou voltou): entra no registro com sequência 0,
  // porque não vem do diário de nenhum PC.
  function recordLocal(entry, type, status, detail) {
    if (!eventLog) return;
    const known = status || live.get(entry.hostId)?.status || {};
    const event = {
      v: 2,
      hostId: entry.hostId,
      hostName: known.hostName || entry.name,
      seq: 0,
      at: now(),
      type,
      detail,
    };
    if (known.student?.label) event.student = { label: known.student.label, account: '' };
    try {
      eventLog.add(event, now());
    } catch (err) {
      log(`registro de acessos: ${err?.message || err}`);
    }
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
    const lost =
      previous.lost === true || (previous.wasActive === true && missed >= MISSES_UNTIL_LOST);
    live.set(entry.hostId, { ...previous, state, missed, error: undefined, lost });
    if (lost && previous.lost !== true) {
      recordLocal(
        entry,
        'host-lost',
        previous.status,
        `sem resposta há ${missed * 10} s com uma reserva em andamento`,
      );
    }
  }

  // ---- Eventos do PC: consulta por número de sequência (GOALS 19) ----

  const syncing = new Set();
  const pendingSyncs = new Set();

  // Pede ao PC os eventos que faltam, a partir do ponto em que a sequência deste PC está completa.
  // O mesmo evento pode chegar por push e por aqui: o registro junta pelo par (hostId, seq).
  async function syncEvents(entry, remoteLastSeq) {
    if (!eventLog || syncing.has(entry.hostId)) return;
    const name = live.get(entry.hostId)?.status?.hostName || entry.name;
    if (!Number.isSafeInteger(remoteLastSeq)) return;
    const start = eventLog.cursor(entry.hostId);
    if (remoteLastSeq < start) {
      // O diário do PC recomeçou (apagado ou reinstalado): o que ele registrar com números que já
      // temos não dá para juntar; fica registrado que há uma lacuna.
      eventLog.addGap({
        hostId: entry.hostId,
        hostName: name,
        fromSeq: remoteLastSeq + 1,
        toSeq: start,
        reason: 'reset',
      });
      return;
    }
    if (remoteLastSeq === start) return;
    syncing.add(entry.hostId);
    try {
      let cursor = start;
      for (let round = 0; round < SYNC_MAX_ROUNDS && cursor < remoteLastSeq; round += 1) {
        const built = protocol.buildRequest('lab-events', { sinceSeq: cursor, limit: SYNC_PAGE });
        const result = await sendRequest(entry.host, built, { timeoutMs: SYNC_TIMEOUT_MS });
        if (!result.ok || !result.response.ok) break;
        const body = result.response;
        if (body.labProtocol !== protocol.LAB_PROTOCOL) break;
        const page = protocol.eventsPayload(body);
        // Só vale o que é deste PC: um PC não escreve no histórico de outro.
        const mine = page.events.filter((event) => event.hostId === entry.hostId);
        if (mine.length === 0) {
          // O diário do PC já não tem nada depois do que sei: o que foi apagado é uma lacuna.
          if (page.firstSeq > cursor + 1) {
            eventLog.addGap({
              hostId: entry.hostId,
              hostName: name,
              fromSeq: cursor + 1,
              toSeq: Math.min(page.firstSeq - 1, page.lastSeq || page.firstSeq - 1),
              reason: 'rotated',
            });
          }
          break;
        }
        let expected = cursor + 1;
        if (page.firstSeq > expected) {
          eventLog.addGap({
            hostId: entry.hostId,
            hostName: name,
            fromSeq: expected,
            toSeq: page.firstSeq - 1,
            reason: 'rotated',
          });
          expected = page.firstSeq;
        }
        for (const event of mine) {
          if (event.seq > expected) {
            eventLog.addGap({
              hostId: entry.hostId,
              hostName: name,
              fromSeq: expected,
              toSeq: event.seq - 1,
              reason: 'missing',
            });
          }
          eventLog.add(event, now());
          expected = event.seq + 1;
        }
        const next = eventLog.cursor(entry.hostId);
        if (next <= cursor) break;
        cursor = next;
      }
      eventLog.saveCursors();
    } catch (err) {
      log(`consulta de eventos de ${entry.host} falhou: ${err?.message || err}`);
    } finally {
      syncing.delete(entry.hostId);
    }
  }

  async function pollEntry(entry) {
    const built = protocol.buildRequest('lab-status');
    const result = await sendRequest(entry.host, built, {
      timeoutMs: pollTimeoutMs,
    });
    if (result.ok && result.response.ok) {
      applyStatusResponse(entry, result.response);
      const info = live.get(entry.hostId);
      // Só se consulta o diário de um PC que respondeu como o PC matriculado. Em segundo plano: uma
      // consulta longa de eventos não atrasa a lista de PCs na tela.
      if (info?.status) {
        const pending = syncEvents(entry, info.status.lastSeq).catch(() => {});
        pendingSyncs.add(pending);
        pending.finally(() => pendingSyncs.delete(pending));
      }
    } else {
      applyFailure(entry, result);
    }
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

  // ---- GOALS 18: alunos, reserva, troca de aluno e pasta de um PC ----

  // Só se manda uma ação a um PC que acabou de responder: um IP reaproveitado já virou
  // 'offline' (host-mismatch) na consulta periódica.
  const ACTIONABLE_STATES = new Set(['free', 'reserved', 'in-use']);
  const busyHosts = new Set();

  function actionTarget(hostId) {
    const entry = store.getLab().roster.find((item) => item.hostId === hostId);
    if (!entry) return { error: { ok: false, error: 'unknown-pc', message: 'PC fora da lista' } };
    const state = (live.get(hostId) || { state: 'checking' }).state;
    if (!ACTIONABLE_STATES.has(state)) {
      return {
        error: {
          ok: false,
          error: state,
          message: ACTION_REFUSALS[state] || 'Este PC não está disponível agora',
        },
      };
    }
    return { entry };
  }

  function actionFailure(type, result) {
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        message: ACTION_ERRORS[result.error] || result.message,
      };
    }
    const { response } = result;
    if (response.labProtocol !== protocol.LAB_PROTOCOL) {
      return { ok: false, error: 'incompatible', message: ACTION_REFUSALS.incompatible };
    }
    const failure = {
      ok: false,
      error: response.error,
      message: ACTION_ERRORS[response.error] || response.message || 'O PC recusou o pedido',
    };
    // O texto do próprio serviço diz mais (quem está com o PC, o limite de alunos).
    if (response.error === 'busy' || response.error === 'full') {
      failure.message = response.message || failure.message;
    }
    if (response.busyWith) failure.busyWith = protocol.busyPayload(response.busyWith);
    return failure;
  }

  // Uma ação em um PC: valida o pedido, manda e devolve { ok, response } ou o motivo.
  async function act(hostId, type, fields) {
    const target = actionTarget(hostId);
    if (target.error) return target.error;
    const built = protocol.buildRequest(type, fields);
    if (!built.ok) return { ok: false, error: 'bad-request', message: built.message };
    const result = await sendRequest(target.entry.host, built, {
      timeoutMs: ACTION_TIMEOUTS[type] || 10_000,
    });
    if (result.ok && result.response.ok) {
      if (result.response.labProtocol !== protocol.LAB_PROTOCOL) {
        return actionFailure(type, result);
      }
      return { ok: true, response: result.response, entry: target.entry };
    }
    return actionFailure(type, result);
  }

  // Uma ação que muda o PC por vez: um clique duplo não vira dois pedidos.
  async function exclusive(hostId, operation) {
    if (busyHosts.has(hostId)) {
      return {
        ok: false,
        error: 'busy',
        message: 'Há outra operação em andamento nesse PC; aguarde terminar',
      };
    }
    busyHosts.add(hostId);
    try {
      return await operation();
    } finally {
      busyHosts.delete(hostId);
      pollOnce().catch(() => {});
    }
  }

  async function students(hostId) {
    const done = await act(hostId, 'lab-students', {});
    if (!done.ok) return done;
    return { ok: true, ...protocol.studentsPayload(done.response) };
  }

  function studentResult(done) {
    if (!done.ok) return done;
    const student = protocol.studentPayload(done.response.student);
    if (!student.account) return { ok: false, error: 'bad-response', message: BAD_ANSWER };
    return { ok: true, student };
  }

  const addStudent = (hostId, { label, quotaGb } = {}) =>
    exclusive(hostId, async () =>
      studentResult(await act(hostId, 'lab-student-add', { label, quotaGb })),
    );

  const setQuota = (hostId, { account, quotaGb } = {}) =>
    exclusive(hostId, async () =>
      studentResult(await act(hostId, 'lab-student-quota', { account, quotaGb })),
    );

  const deleteStudent = (hostId, account) =>
    exclusive(hostId, async () => {
      const done = await act(hostId, 'lab-student-delete', { account });
      return done.ok ? { ok: true, account } : done;
    });

  async function reserveNow(hostId, { account, startWithinMs, sessionMs }) {
    const done = await act(hostId, 'lab-reserve', { account, startWithinMs, sessionMs });
    if (!done.ok) return done;
    // A senha é entregue UMA vez, a quem pediu, e não fica guardada aqui.
    const credentials = protocol.credentialsPayload(done.response);
    if (!credentials) return { ok: false, error: 'bad-response', message: BAD_ANSWER };
    log(`reserva para ${credentials.account} em ${done.entry.name}`);
    return {
      ok: true,
      credentials,
      pc: { hostId, name: done.entry.name, host: done.entry.host },
    };
  }

  const reserve = (hostId, fields = {}) => exclusive(hostId, () => reserveNow(hostId, fields));

  const extend = (hostId, { reservationId, addMs } = {}) =>
    exclusive(hostId, async () => {
      const done = await act(hostId, 'lab-extend', { reservationId, addMs });
      if (!done.ok) return done;
      const extended = protocol.extendPayload(done.response);
      if (!extended) return { ok: false, error: 'bad-response', message: BAD_ANSWER };
      return { ok: true, ...extended };
    });

  async function endNow(hostId, { reservationId, reason = 'manager-ended' }) {
    const done = await act(hostId, 'lab-end', { reservationId, reason });
    return done.ok ? { ok: true, reason } : done;
  }

  const end = (hostId, fields = {}) => exclusive(hostId, () => endNow(hostId, fields));

  // "Trocar aluno": encerra a sessão de quem está no PC (com o aviso) e SÓ DEPOIS
  // reserva para o próximo. Se o encerramento falhar, nada é reservado.
  const handOver = (hostId, { account, startWithinMs, sessionMs } = {}) =>
    exclusive(hostId, async () => {
      const current = await students(hostId);
      if (!current.ok) return { ...current, step: 'list' };
      let previous = null;
      if (current.reservation) {
        previous = { account: current.reservation.account, label: current.reservation.label };
        const ended = await endNow(hostId, {
          reservationId: current.reservation.id,
          reason: 'manager-handover',
        });
        // "Não achei a reserva": acabou sozinha entre a consulta e o pedido; segue.
        if (!ended.ok && ended.error !== 'not-found') {
          return {
            ...ended,
            step: 'end',
            message: `${ended.message}. Nada foi reservado para o próximo aluno.`,
          };
        }
      }
      const reserved = await reserveNow(hostId, { account, startWithinMs, sessionMs });
      if (!reserved.ok) return { ...reserved, step: 'reserve', ended: previous !== null };
      return { ...reserved, previous };
    });

  // "Ver pasta": a conexão que o PC abre vira uma sessão de arquivos somente leitura,
  // que a tela de Arquivos usa como qualquer outra.
  async function openFolder(hostId, account) {
    const target = actionTarget(hostId);
    if (target.error) return target.error;
    const built = protocol.buildRequest('lab-folder', { account });
    if (!built.ok) return { ok: false, error: 'bad-request', message: built.message };
    const result = await openFolderRequest(target.entry.host, built, {
      timeoutMs: ACTION_TIMEOUTS['lab-folder'],
    });
    if (!result.ok || !result.response.ok) {
      return actionFailure('lab-folder', result);
    }
    if (result.response.labProtocol !== protocol.LAB_PROTOCOL) {
      result.socket?.destroy();
      return actionFailure('lab-folder', result);
    }
    const { sessionId } = adoptFileSession(target.entry.host, result.socket, { readOnly: true });
    const label = protocol.studentPayload({
      account: result.response.account,
      label: result.response.label,
    });
    log(`pasta de ${account} aberta em ${target.entry.name} (somente leitura)`);
    return {
      ok: true,
      sessionId,
      host: target.entry.host,
      pcName: target.entry.name,
      account: label.account || account,
      label: label.label || account,
    };
  }

  return {
    addStudent,
    deleteStudent,
    end,
    enroll,
    extend,
    handOver,
    openFolder,
    pollOnce,
    remove,
    reserve,
    setQuota,
    snapshot,
    settled: () => Promise.all([...pendingSyncs]),
    start,
    stop,
    students,
  };
}

module.exports = {
  createLabManager,
  ENROLL_TIMEOUT_MS,
  MAX_PARALLEL,
  MISSES_UNTIL_OFFLINE,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
};
