'use strict';

// Canais IPC das contas (renderer ↔ main). A tela é só uma tela: cada canal valida a entrada de novo
// e nenhum devolve token ou senha — só o estado de auth-service.js. Quem manda é o banco (RLS), não
// estes limites; eles evitam pedidos tortos e mensagens de erro confusas.

const CHANNELS = Object.freeze({
  getState: 'auth:getState',
  state: 'auth:state', // main → renderer (assinatura): o estado mudou
  signUp: 'auth:signUp',
  verifyCode: 'auth:verifyCode',
  resendCode: 'auth:resendCode',
  signIn: 'auth:signIn',
  signOut: 'auth:signOut',
  resetRequest: 'auth:resetRequest',
  resetConfirm: 'auth:resetConfirm',
  noAccount: 'auth:noAccount',
  teacherRequests: 'auth:teacherRequests',
  decideTeacher: 'auth:decideTeacher',
});

const INVOKE_CHANNELS = Object.freeze([
  CHANNELS.getState,
  CHANNELS.signUp,
  CHANNELS.verifyCode,
  CHANNELS.resendCode,
  CHANNELS.signIn,
  CHANNELS.signOut,
  CHANNELS.resetRequest,
  CHANNELS.resetConfirm,
  CHANNELS.noAccount,
  CHANNELS.teacherRequests,
  CHANNELS.decideTeacher,
]);
const PUSH_CHANNELS = Object.freeze([CHANNELS.state]);

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

function badRequest(message = 'Confira os dados digitados.') {
  return { ok: false, error: 'bad-request', message };
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isEmail(value) {
  return (
    typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

// Quem cola o e-mail costuma levar um espaço junto: valida e repassa o texto já aparado.
function cleanEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return isEmail(email) ? email : null;
}

function isPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
}

// Regra do projeto (supabase/config.toml): letras e números.
const isStrongPassword = (value) => isPassword(value) && /[A-Za-z]/.test(value) && /\d/.test(value);

const isCode = (value) => typeof value === 'string' && /^\d{6}$/.test(value);

function cleanName(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= 80 ? name : null;
}

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function createAuthIpcHandlers({ service }) {
  return {
    [CHANNELS.getState]: () => service.getState(),

    [CHANNELS.signUp]: (payload) => {
      if (!isPlain(payload)) return badRequest();
      const fullName = cleanName(payload.fullName);
      if (!fullName) return badRequest('Informe seu nome (até 80 caracteres).');
      if (!cleanEmail(payload.email)) return badRequest('Confira o e-mail digitado.');
      if (!isStrongPassword(payload.password)) {
        return badRequest('A senha precisa ter de 8 a 72 caracteres, com letras e números.');
      }
      if (payload.role !== 'aluno' && payload.role !== 'professor') return badRequest();
      return service.signUp({
        fullName,
        email: cleanEmail(payload.email),
        password: payload.password,
        wantsTeacher: payload.role === 'professor',
      });
    },

    [CHANNELS.verifyCode]: (payload) => {
      if (!isPlain(payload) || !cleanEmail(payload.email)) return badRequest();
      if (!isCode(payload.code)) return badRequest('O código tem 6 números.');
      return service.verifyCode({ email: cleanEmail(payload.email), code: payload.code });
    },

    [CHANNELS.resendCode]: (payload) => {
      if (!isPlain(payload) || !cleanEmail(payload.email)) return badRequest();
      return service.resendCode({ email: cleanEmail(payload.email) });
    },

    [CHANNELS.signIn]: (payload) => {
      if (!isPlain(payload) || !cleanEmail(payload.email))
        return badRequest('Confira o e-mail digitado.');
      if (!isPassword(payload.password)) {
        return badRequest('A senha tem de 8 a 72 caracteres.');
      }
      return service.signIn({ email: cleanEmail(payload.email), password: payload.password });
    },

    [CHANNELS.signOut]: () => service.signOut(),

    [CHANNELS.resetRequest]: (payload) => {
      if (!isPlain(payload) || !cleanEmail(payload.email))
        return badRequest('Confira o e-mail digitado.');
      return service.requestReset({ email: cleanEmail(payload.email) });
    },

    [CHANNELS.resetConfirm]: (payload) => {
      if (!isPlain(payload) || !cleanEmail(payload.email)) return badRequest();
      if (!isCode(payload.code)) return badRequest('O código tem 6 números.');
      if (!isStrongPassword(payload.password)) {
        return badRequest('A senha precisa ter de 8 a 72 caracteres, com letras e números.');
      }
      return service.confirmReset({
        email: cleanEmail(payload.email),
        code: payload.code,
        password: payload.password,
      });
    },

    [CHANNELS.noAccount]: () => service.useWithoutAccount(),

    [CHANNELS.teacherRequests]: () => service.listTeacherRequests(),

    [CHANNELS.decideTeacher]: (payload) => {
      if (!isPlain(payload) || !isUuid(payload.id) || typeof payload.approve !== 'boolean') {
        return badRequest();
      }
      return service.decideTeacherRequest({ id: payload.id, approve: payload.approve });
    },
  };
}

// `ipcMain` vem do Electron (main.js); aqui só se liga um ao outro.
function registerAuthIpc({ ipcMain, handlers }) {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (_event, payload) => handlers[channel](payload));
  }
}

module.exports = {
  CHANNELS,
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  createAuthIpcHandlers,
  isCode,
  isEmail,
  isPassword,
  isStrongPassword,
  isUuid,
  registerAuthIpc,
};
