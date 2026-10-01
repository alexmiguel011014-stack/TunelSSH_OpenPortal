'use strict';

// Canais IPC do modo laboratório (renderer ↔ main). Cada handler valida a
// entrada, porque o renderer é só uma tela: nenhum canal devolve segredo e
// nenhum deixa o renderer mudar quem é gerente (só o main, ao aceitar uma
// matrícula, ou o "Remover gerente" local).

const { EVENT_TYPES, groupReservations } = require('./events');

const CHANNELS = Object.freeze({
  roster: 'lab:roster',
  add: 'lab:add',
  remove: 'lab:remove',
  status: 'lab:status', // main → renderer (assinatura): lista atualizada
  open: 'lab:open',
  managers: 'lab:managers',
  removeManager: 'lab:removeManager',
  hostChanged: 'lab:hostChanged', // main → renderer: gerentes ou modo mudaram
  getStartWithWindows: 'lab:getStartWithWindows',
  setStartWithWindows: 'lab:setStartWithWindows',
  serviceState: 'lab:serviceState',
  enableService: 'lab:enableService',
  disableService: 'lab:disableService',
  // GOALS 18: alunos, reserva e pasta de um PC de laboratório.
  students: 'lab:students',
  studentAdd: 'lab:studentAdd',
  studentQuota: 'lab:studentQuota',
  studentDelete: 'lab:studentDelete',
  reserve: 'lab:reserve',
  handOver: 'lab:handOver',
  extend: 'lab:extend',
  end: 'lab:end',
  folder: 'lab:folder',
  // GOALS 19: o registro central de acessos.
  logQuery: 'lab:logQuery',
  logExport: 'lab:logExport',
  logRetention: 'lab:logRetention',
  setLogRetention: 'lab:setLogRetention',
  logChanged: 'lab:logChanged', // main → renderer: chegou evento novo
});

// Os canais que o renderer chama (invoke); os outros só empurram dados.
const INVOKE_CHANNELS = Object.freeze([
  CHANNELS.roster,
  CHANNELS.add,
  CHANNELS.remove,
  CHANNELS.open,
  CHANNELS.managers,
  CHANNELS.removeManager,
  CHANNELS.getStartWithWindows,
  CHANNELS.setStartWithWindows,
  CHANNELS.serviceState,
  CHANNELS.enableService,
  CHANNELS.disableService,
  CHANNELS.students,
  CHANNELS.studentAdd,
  CHANNELS.studentQuota,
  CHANNELS.studentDelete,
  CHANNELS.reserve,
  CHANNELS.handOver,
  CHANNELS.extend,
  CHANNELS.end,
  CHANNELS.folder,
  CHANNELS.logQuery,
  CHANNELS.logExport,
  CHANNELS.logRetention,
  CHANNELS.setLogRetention,
]);
const PUSH_CHANNELS = Object.freeze([CHANNELS.status, CHANNELS.hostChanged, CHANNELS.logChanged]);

// Estados em que "Abrir tela" tem sentido (o PC responde e não tem aluno na sessão).
const OPENABLE_STATES = new Set(['free', 'reserved']);

const OPEN_REFUSALS = {
  'in-use': 'Há um aluno usando este PC; para ver os arquivos dele abra "Alunos" e use "Ver pasta"',
  offline: 'Este PC não está respondendo',
  incompatible: 'Este PC tem uma versão do modo laboratório diferente da deste app',
  refused: 'Este PC não reconhece mais você como gerente',
  checking: 'Ainda estou consultando este PC; tente de novo em instantes',
};

function isId(value, max = 64) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function badRequest(message = 'Pedido inválido') {
  return { ok: false, error: 'bad-request', message };
}

function isAccount(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,20}$/.test(value);
}

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Os campos de uma ação, copiados um a um do que o renderer mandou: nada além da lista
// passa, e o gerente (manager.js) valida os valores de novo antes de ir à rede.
function pick(payload, names) {
  const fields = {};
  for (const name of names) fields[name] = payload[name];
  return fields;
}

function hostState(store) {
  const lab = store.getLab();
  return { mode: lab.mode, managed: lab.managed, managers: lab.managers };
}

// Os filtros da tela de atividade, copiados campo a campo e limpos: nada além da lista passa.
const MAX_LOG_ROWS = 5000;
function sanitizeLogFilters(payload) {
  const source = isPlain(payload) ? payload : {};
  const filters = {};
  if (typeof source.hostId === 'string' && source.hostId && source.hostId.length <= 64) {
    filters.hostId = source.hostId;
  }
  if (typeof source.student === 'string' && source.student.trim()) {
    filters.student = source.student.trim().slice(0, 60);
  }
  for (const key of ['from', 'to']) {
    if (Number.isFinite(source[key]) && source[key] > 0 && source[key] < 4_102_444_800_000) {
      filters[key] = source[key];
    }
  }
  if (Array.isArray(source.types)) {
    const types = source.types.filter((type) => EVENT_TYPES.includes(type));
    if (types.length) filters.types = [...new Set(types)];
  }
  return filters;
}

function createLabIpcHandlers({
  manager,
  store,
  eventLog = null,
  startWithWindows,
  serviceControl,
  onHostChanged = () => {},
  onManagerRemoved = () => {},
}) {
  // Ligar ou desligar abre um pedido de administrador (UAC): um por vez.
  let changingService = false;
  const exclusive = async (operation) => {
    if (changingService) {
      return { ok: false, error: 'busy', message: 'Há outra alteração em andamento' };
    }
    changingService = true;
    try {
      return await operation();
    } finally {
      changingService = false;
    }
  };

  return {
    [CHANNELS.roster]: () => manager.snapshot(),

    [CHANNELS.add]: async (payload) => {
      const host = typeof payload === 'string' ? payload : payload?.host;
      if (!isId(host, 45)) return badRequest('Informe o IP do PC');
      return manager.enroll(host);
    },

    [CHANNELS.remove]: (hostId) => {
      if (!isId(hostId)) return badRequest();
      return manager.remove(hostId);
    },

    // Devolve só o que o renderer precisa para pedir acesso pelo fluxo normal
    // (connectMachine): o gerente é aprovado sem diálogo no PC.
    [CHANNELS.open]: (hostId) => {
      if (!isId(hostId)) return badRequest();
      const entry = manager.snapshot().find((item) => item.hostId === hostId);
      if (!entry) return { ok: false, error: 'unknown-pc', message: 'PC fora da lista' };
      if (!OPENABLE_STATES.has(entry.state)) {
        return {
          ok: false,
          error: entry.state,
          message: OPEN_REFUSALS[entry.state],
        };
      }
      return {
        ok: true,
        machine: {
          id: `lab-${entry.hostId}`,
          name: entry.name,
          host: entry.host,
          port: 5900,
        },
      };
    },

    [CHANNELS.managers]: () => hostState(store),

    [CHANNELS.removeManager]: (login) => {
      if (!isId(login, 200)) return badRequest();
      const result = store.removeManager(login);
      if (result.removed) {
        onManagerRemoved(login);
        onHostChanged();
      }
      return { ok: result.removed, ...hostState(store) };
    },

    [CHANNELS.getStartWithWindows]: () => startWithWindows.get(),

    [CHANNELS.setStartWithWindows]: (enabled) => {
      if (typeof enabled !== 'boolean') return badRequest();
      return startWithWindows.set(enabled);
    },

    [CHANNELS.serviceState]: () => serviceControl.getState(),

    [CHANNELS.enableService]: (options) => {
      if (options !== undefined && options !== null && typeof options !== 'object')
        return badRequest();
      const studentsOnSite = options?.studentsOnSite;
      if (studentsOnSite !== undefined && typeof studentsOnSite !== 'boolean') return badRequest();
      return exclusive(() => serviceControl.enable({ studentsOnSite: studentsOnSite === true }));
    },

    [CHANNELS.disableService]: () => exclusive(() => serviceControl.disable()),

    // ---- GOALS 18: o gerente sobre um PC de laboratório ----
    // Nenhum destes canais devolve segredo além da resposta de reserva/troca, que
    // traz a senha do aluno UMA vez, para a janela de credenciais.
    [CHANNELS.students]: (hostId) => {
      if (!isId(hostId)) return badRequest();
      return manager.students(hostId);
    },

    [CHANNELS.studentAdd]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId)) return badRequest();
      return manager.addStudent(payload.hostId, pick(payload, ['label', 'quotaGb']));
    },

    [CHANNELS.studentQuota]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      return manager.setQuota(payload.hostId, pick(payload, ['account', 'quotaGb']));
    },

    [CHANNELS.studentDelete]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      return manager.deleteStudent(payload.hostId, payload.account);
    },

    [CHANNELS.reserve]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      return manager.reserve(
        payload.hostId,
        pick(payload, ['account', 'startWithinMs', 'sessionMs']),
      );
    },

    [CHANNELS.handOver]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      return manager.handOver(
        payload.hostId,
        pick(payload, ['account', 'startWithinMs', 'sessionMs']),
      );
    },

    [CHANNELS.extend]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isId(payload.reservationId)) {
        return badRequest();
      }
      return manager.extend(payload.hostId, pick(payload, ['reservationId', 'addMs']));
    },

    [CHANNELS.end]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isId(payload.reservationId)) {
        return badRequest();
      }
      return manager.end(payload.hostId, { reservationId: payload.reservationId });
    },

    [CHANNELS.folder]: (payload) => {
      if (!isPlain(payload) || !isId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      return manager.openFolder(payload.hostId, payload.account);
    },

    // ---- GOALS 19: o registro central de acessos ----
    // Devolve os eventos que passam nos filtros (os mais recentes, até 5000), as lacunas, as
    // reservas já agrupadas e os PCs e alunos que aparecem, para a tela montar os filtros.
    [CHANNELS.logQuery]: (payload) => {
      if (!eventLog) return { ok: false, error: 'unsupported', message: 'Registro indisponível' };
      const result = eventLog.query(sanitizeLogFilters(payload));
      const truncated = result.events.length > MAX_LOG_ROWS;
      const rows = truncated ? result.events.slice(-MAX_LOG_ROWS) : result.events;
      return {
        ok: true,
        events: rows,
        gaps: result.gaps,
        reservations: groupReservations(rows),
        facets: eventLog.facets(),
        truncated,
        total: result.events.length,
      };
    },

    [CHANNELS.logExport]: (payload) => {
      if (!eventLog) return { ok: false, error: 'unsupported', message: 'Registro indisponível' };
      const stamp = new Date().toISOString().slice(0, 10);
      return {
        ok: true,
        filename: `registro-de-acessos-${stamp}.csv`,
        csv: eventLog.exportCsv(sanitizeLogFilters(payload)),
      };
    },

    [CHANNELS.logRetention]: () => ({ ok: true, days: store.getLab().logRetentionDays }),

    [CHANNELS.setLogRetention]: (days) => {
      if (!eventLog) return { ok: false, error: 'unsupported', message: 'Registro indisponível' };
      if (!Number.isFinite(days)) return badRequest('Informe o número de dias');
      const saved = store.setLogRetentionDays(days);
      eventLog.setRetentionDays(saved);
      const removed = eventLog.applyRetention(saved);
      return { ok: true, days: saved, removed };
    },
  };
}

// `ipcMain` e `send` vêm do Electron (main.js); aqui só se liga um ao outro.
function registerLabIpc({ ipcMain, handlers }) {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (_event, payload) => handlers[channel](payload));
  }
}

module.exports = {
  CHANNELS,
  INVOKE_CHANNELS,
  OPENABLE_STATES,
  PUSH_CHANNELS,
  createLabIpcHandlers,
  registerLabIpc,
};
