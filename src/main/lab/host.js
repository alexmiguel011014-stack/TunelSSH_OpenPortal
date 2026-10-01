'use strict';

// Lado do PC gerenciado (GOALS 16): recebe as mensagens `lab-*` que o
// ConnectionRequestServer entrega com o endereço REAL do socket, descobre quem
// é pelo `tailscale whois`, e só atende quem está em `lab.managers` — a única
// exceção é `lab-enroll`, que pede o clique da pessoa que está no PC.
//
// Tudo que toca o sistema (whois, diálogo, disco, relógio) entra por `deps`,
// para o teste rodar sem Tailscale, sem Electron e sem rede.

const path = require('path');
const events = require('./events');
const protocol = require('./protocol');

const IDENTITY_TTL_MS = 60 * 1000;
const UNKNOWN_IDENTITY_TTL_MS = 5 * 1000;
const IDENTITY_CACHE_MAX = 256;
const ENROLL_DIALOG_MS = 60 * 1000;

// Erros do pipe que significam "o serviço não está ao alcance" (parado, lento ou sem resposta).
const SERVICE_DOWN = new Set(['service-down', 'unreachable', 'timeout']);
// Recusas do próprio serviço que o gerente precisa ver como estão.
const SERVICE_ERRORS = new Set([
  'bad-request',
  'busy',
  'not-found',
  'full',
  'logoff-failed',
  'unsupported',
  'internal',
]);
// A pasta de um aluno é uma pasta direta de C:\Users (a unidade do sistema); qualquer outra
// coisa que o serviço devolva não é aberta.
const NOT_STUDENT_FOLDERS = new Set(['public', 'default', 'default user', 'all users']);
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

function defaultUsersRoot() {
  return `${process.env.SystemDrive || 'C:'}\\Users`;
}

function isStudentProfilePath(value, usersRoot) {
  if (typeof value !== 'string' || value === '') return false;
  const win = path.win32;
  if (!win.isAbsolute(value) || win.normalize(value) !== value) return false;
  if (win.dirname(value).toLowerCase() !== win.normalize(usersRoot).toLowerCase()) return false;
  const name = win.basename(value);
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !BAD_NAME_CHARS.test(name) &&
    !NOT_STUDENT_FOLDERS.has(name.toLowerCase())
  );
}

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
    service = null,
    usersRoot = defaultUsersRoot(),
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
    note('manager-enrolled', login);
    try {
      onEnrolled(login);
    } catch {}
    return protocol.buildSuccess('lab-enroll', {
      accepted: true,
      ...hostIdentity(),
    });
  }

  // ---- GOALS 18: alunos, reserva e pasta (tudo passa pelo serviço do laboratório) ----

  // O que se registra de um pedido do gerente: quem, o quê e qual conta. Nunca a
  // senha, que só existe na resposta de `lab-reserve`.
  function audit(login, request) {
    const target = request.account ? ` (${request.account})` : '';
    log(`${login}: ${request.type}${target}`);
  }

  function serviceFailure(type, result) {
    const code = result?.error;
    if (SERVICE_DOWN.has(code)) {
      log(`o serviço não respondeu a ${type}: ${code}`);
      return protocol.buildError(
        type,
        'service-down',
        'O serviço do laboratório não está respondendo neste PC',
      );
    }
    if (SERVICE_ERRORS.has(code)) {
      const busyWith = code === 'busy' && result.endsAt !== undefined ? { busyWith: result } : {};
      return protocol.buildError(type, code, result.message, busyWith);
    }
    log(`o serviço recusou ${type}: ${code || 'sem código'}`);
    return protocol.buildError(type, 'internal', 'O serviço do laboratório não concluiu o pedido');
  }

  async function students() {
    const [state, disk] = await Promise.all([
      service.status({ timeoutMs: 3000 }),
      service.diskInfo({}, { timeoutMs: 3000 }),
    ]);
    if (!state.ok) return serviceFailure('lab-students', state);
    return protocol.buildSuccess(
      'lab-students',
      protocol.studentsPayload({ ...state, capacity: disk.ok ? disk : undefined }),
    );
  }

  async function reserve(request) {
    const result = await service.reserve(
      {
        account: request.account,
        startWithinMs: request.startWithinMs,
        sessionMs: request.sessionMs,
      },
      { timeoutMs: 20_000 },
    );
    if (!result.ok) return serviceFailure('lab-reserve', result);
    const credentials = protocol.credentialsPayload(result);
    if (!credentials) {
      log('o serviço reservou, mas a resposta não tinha a forma esperada');
      return protocol.buildError('lab-reserve', 'internal', 'Resposta inesperada do serviço');
    }
    return protocol.buildSuccess('lab-reserve', credentials);
  }

  async function folder(request) {
    const access = await service.ensureFolderAccess(request.account, { timeoutMs: 120_000 });
    if (!access.ok) return serviceFailure('lab-folder', access);
    const root = typeof access.path === 'string' ? access.path : '';
    if (!isStudentProfilePath(root, usersRoot)) {
      log('o serviço devolveu uma pasta fora de C:\\Users; pedido recusado');
      return protocol.buildError('lab-folder', 'internal', 'Pasta do aluno indisponível');
    }
    const state = await service.status({ timeoutMs: 3000 });
    const known = state.ok && Array.isArray(state.students) ? state.students : [];
    const label = known.find((student) => student?.account === request.account)?.label;
    const response = protocol.buildSuccess('lab-folder', {
      account: request.account,
      label: typeof label === 'string' ? label.slice(0, 40) : request.account,
    });
    // A conexão vira uma sessão de arquivos só de leitura nesta pasta.
    response[protocol.FILE_SESSION] = { root, readOnly: true };
    return response;
  }

  // O diário do serviço, como eventos v2 deste PC. Um número de sequência que o serviço não
  // devolver direito (tipo desconhecido, campo torto) é pulado: o gerente vê o salto.
  async function journalEvents(request) {
    const result = await service.events(
      { sinceSeq: request.sinceSeq, limit: request.limit },
      { timeoutMs: 8000 },
    );
    if (!result.ok) return serviceFailure('lab-events', result);
    const pc = hostIdentity();
    const mapped = (Array.isArray(result.events) ? result.events : [])
      .map((entry) => events.fromJournalEntry(entry, pc))
      .filter(Boolean);
    return protocol.buildSuccess(
      'lab-events',
      protocol.eventsPayload({
        events: mapped,
        lastSeq: result.lastSeq,
        firstSeq: result.firstSeq,
      }),
    );
  }

  // Registra no diário do serviço um fato que só este app conhece (quem foi aceito ou removido
  // como gerente). Melhor esforço: sem serviço, o fato simplesmente não é registrado.
  async function note(type, detail) {
    if (!service) return;
    try {
      await service.note({ type, detail }, { timeoutMs: 3000 });
    } catch {}
  }

  async function dispatchService(request, login) {
    const { type } = request;
    if (!service) {
      return protocol.buildError(type, 'service-down', 'O serviço do laboratório não está ativo');
    }
    // Só o que muda algo entra no registro do PC: as consultas se repetem a cada poucos segundos.
    if (type !== 'lab-students' && type !== 'lab-events') audit(login, request);
    switch (type) {
      case 'lab-students':
        return await students();
      case 'lab-student-add': {
        const result = await service.studentCreate(
          { label: request.label, quotaGb: request.quotaGb },
          { timeoutMs: 60_000 },
        );
        if (!result.ok) return serviceFailure(type, result);
        return protocol.buildSuccess(type, { student: protocol.studentPayload(result) });
      }
      case 'lab-student-quota': {
        const result = await service.studentSetQuota(
          { account: request.account, quotaGb: request.quotaGb },
          { timeoutMs: 30_000 },
        );
        if (!result.ok) return serviceFailure(type, result);
        return protocol.buildSuccess(type, { student: protocol.studentPayload(result) });
      }
      case 'lab-student-delete': {
        const result = await service.studentDelete(request.account, { timeoutMs: 120_000 });
        if (!result.ok) return serviceFailure(type, result);
        return protocol.buildSuccess(type, { account: request.account });
      }
      case 'lab-reserve':
        return await reserve(request);
      case 'lab-extend': {
        const result = await service.extend(
          { reservationId: request.reservationId, addMs: request.addMs },
          { timeoutMs: 10_000 },
        );
        if (!result.ok) return serviceFailure(type, result);
        const extended = protocol.extendPayload(result);
        if (!extended) {
          return protocol.buildError(type, 'internal', 'Resposta inesperada do serviço');
        }
        return protocol.buildSuccess(type, extended);
      }
      case 'lab-end': {
        const result = await service.end(
          { reservationId: request.reservationId, reason: request.reason },
          { timeoutMs: 90_000 },
        );
        if (!result.ok) return serviceFailure(type, result);
        return protocol.buildSuccess(type, { ended: true, reason: request.reason });
      }
      case 'lab-folder':
        return await folder(request);
      case 'lab-events':
        return await journalEvents(request);
      default:
        return protocol.buildError(type, 'unsupported', 'Recurso ainda não disponível neste PC');
    }
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
      return await dispatchService(request, login);
    } catch (err) {
      log(`erro ao atender ${ip}: ${err?.message || err}`);
      return protocol.buildError(undefined, 'internal', 'Falha ao atender o pedido');
    }
  }

  return { handle, note };
}

module.exports = { createLabHost, normalizeIp, ENROLL_DIALOG_MS };
