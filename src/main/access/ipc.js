'use strict';

// Canais IPC de "Meu acesso" e dos vínculos (GOALS 21; renderer ↔ main). A tela é só uma tela: cada
// canal valida a entrada de novo, e o que vale (quem pode ler ou escrever) é decidido pelo banco.
// O canal `access:mine` entrega a senha do aluno ao próprio aluno — é a única resposta daqui que a traz.

const CHANNELS = Object.freeze({
  searchStudents: 'access:searchStudents',
  links: 'access:links',
  link: 'access:link',
  unlink: 'access:unlink',
  mine: 'access:mine',
  mineChanged: 'access:mineChanged', // main → renderer (assinatura): o acesso do aluno mudou
  openRdp: 'access:openRdp',
  copyPassword: 'access:copyPassword',
});

const INVOKE_CHANNELS = Object.freeze([
  CHANNELS.searchStudents,
  CHANNELS.links,
  CHANNELS.link,
  CHANNELS.unlink,
  CHANNELS.mine,
  CHANNELS.openRdp,
  CHANNELS.copyPassword,
]);
const PUSH_CHANNELS = Object.freeze([CHANNELS.mineChanged]);

const badRequest = (message = 'Pedido inválido') => ({ ok: false, error: 'bad-request', message });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isHostId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;
const isAccount = (value) => typeof value === 'string' && /^[a-z0-9_-]{1,20}$/.test(value);
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 40 ? label : null;
}

function createAccessIpcHandlers({ service }) {
  return {
    [CHANNELS.searchStudents]: (query) => {
      if (query !== undefined && query !== null && typeof query !== 'string') return badRequest();
      if (typeof query === 'string' && query.length > 60) return badRequest('Busca longa demais');
      return service.searchStudents(query ?? '');
    },

    [CHANNELS.links]: (hostId) => {
      if (!isHostId(hostId)) return badRequest();
      return service.listLinks(hostId);
    },

    [CHANNELS.link]: (payload) => {
      if (!isPlain(payload) || !isHostId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      const label = cleanLabel(payload.label);
      if (!label || !isUuid(payload.studentId)) return badRequest();
      return service.link({
        hostId: payload.hostId,
        account: payload.account,
        label,
        studentId: payload.studentId,
      });
    },

    [CHANNELS.unlink]: (payload) => {
      if (!isPlain(payload) || !isHostId(payload.hostId) || !isAccount(payload.account)) {
        return badRequest();
      }
      return service.unlink({ hostId: payload.hostId, account: payload.account });
    },

    [CHANNELS.mine]: () => service.mine(),

    // Sem carga útil de propósito: o endereço e o usuário saem do que o processo principal leu.
    [CHANNELS.openRdp]: () => service.openRdp(),

    [CHANNELS.copyPassword]: () => service.copyPassword(),
  };
}

function registerAccessIpc({ ipcMain, handlers }) {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (_event, payload) => handlers[channel](payload));
  }
}

module.exports = {
  CHANNELS,
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  createAccessIpcHandlers,
  registerAccessIpc,
};
