'use strict';

// Canais IPC do modo laboratório (renderer ↔ main). Cada handler valida a
// entrada, porque o renderer é só uma tela: nenhum canal devolve segredo e
// nenhum deixa o renderer mudar quem é gerente (só o main, ao aceitar uma
// matrícula, ou o "Remover gerente" local).

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
]);
const PUSH_CHANNELS = Object.freeze([CHANNELS.status, CHANNELS.hostChanged]);

// Estados em que "Abrir tela" tem sentido (o PC responde e não tem aluno na sessão).
const OPENABLE_STATES = new Set(['free', 'reserved']);

const OPEN_REFUSALS = {
  'in-use': 'Há um aluno usando este PC; para ver os arquivos dele use "Ver pasta"',
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

function hostState(store) {
  const lab = store.getLab();
  return { mode: lab.mode, managed: lab.managed, managers: lab.managers };
}

function createLabIpcHandlers({
  manager,
  store,
  startWithWindows,
  serviceControl,
  onHostChanged = () => {},
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
      if (result.removed) onHostChanged();
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
