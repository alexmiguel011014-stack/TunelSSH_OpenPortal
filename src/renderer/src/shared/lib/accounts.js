// Regras de apresentação das contas (GOALS 20), sem React: quem a pessoa é para o app, o que cada
// papel vê e a validação dos formulários antes de ir ao processo principal (que valida de novo).
// O estado vem de src/main/auth/auth-service.js e nunca traz token.

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;
export const CODE_LENGTH = 6;
export const RESEND_WAIT_SECONDS = 60;

// ---- quem é a pessoa ----------------------------------------------------------------------
//
// kind: loading | signed-out (mostra a tela de entrada) | legacy (sem contas neste build: o app é
// o de sempre) | guest ("Usar sem conta") | student | pending (quer ser professor, ainda não foi
// aprovado) | teacher.
export function resolveAccount(auth) {
  if (!auth || auth.status === 'loading') return { kind: 'loading' };
  if (auth.status === 'unconfigured') return { kind: 'legacy' };
  if (auth.status === 'signed-in' || auth.status === 'offline') {
    const profile = auth.profile;
    if (!profile) return { kind: 'signed-out' };
    const offline = auth.status === 'offline';
    if (profile.role === 'professor') return { kind: 'teacher', profile, offline };
    return { kind: profile.teacherPending ? 'pending' : 'student', profile, offline };
  }
  if (auth.noAccount) return { kind: 'guest' };
  return { kind: 'signed-out' };
}

// ---- o que cada um vê ---------------------------------------------------------------------
//
// home = a tela inicial "Este PC"; access = "Meu acesso" (GOALS 21); connect = PCs, conexão por IP e
// histórico; files, activity, lab, approvals, config = as telas de mesmo nome.
const VISIBLE_SCREENS = {
  // Sem contas neste build tudo continua como antes das contas existirem.
  legacy: ['home', 'connect', 'files', 'activity', 'lab', 'config'],
  guest: ['home', 'config'],
  student: ['home', 'access', 'config'],
  pending: ['home', 'access', 'config'],
  teacher: ['home', 'connect', 'files', 'activity', 'lab', 'approvals', 'config'],
};

export function canSee(account, screen) {
  return (VISIBLE_SCREENS[account?.kind] || []).includes(screen);
}

export function roleLabel(account) {
  if (account?.kind === 'teacher') return 'Professor';
  if (account?.kind === 'pending') return 'Professor — aguardando aprovação';
  if (account?.kind === 'student') return 'Aluno';
  return '';
}

// A tela em que o app abre: o aluno cai em "Meu acesso", os outros na tela inicial.
export function landingScreen(account) {
  return canSee(account, 'access') ? 'access' : 'home';
}

// O aviso fixo no alto da janela, quando há algo a dizer sobre a conta.
export function accountBanner(account) {
  if (account?.offline) {
    return {
      tone: 'warning',
      text: 'Sem conexão com o servidor de contas. Usando o último perfil salvo neste PC.',
    };
  }
  if (account?.kind === 'pending') {
    return {
      tone: 'info',
      text: 'Seu pedido para ser professor está aguardando aprovação de outro professor. Enquanto isso você usa o OpenPortal como aluno.',
    };
  }
  return null;
}

// ---- formulários --------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateEmail(value) {
  const email = String(value ?? '').trim();
  if (!email) return 'Informe o e-mail.';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'Confira o e-mail digitado.';
  return '';
}

export function validateNewPassword(value) {
  const password = String(value ?? '');
  if (password.length < PASSWORD_MIN)
    return `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (password.length > PASSWORD_MAX)
    return `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Use letras e números na senha.';
  }
  return '';
}

export function validateFullName(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'Informe seu nome.';
  if (name.length > 80) return 'O nome pode ter no máximo 80 caracteres.';
  if (CONTROL_CHARS.test(name)) return 'O nome tem caracteres que não podem ser usados.';
  return '';
}

export function validateCode(value) {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(String(value ?? ''))
    ? ''
    : `O código tem ${CODE_LENGTH} números.`;
}

// Junta os erros por campo; `ok` só quando nenhum campo tem erro.
function collect(errors, values) {
  const found = Object.fromEntries(Object.entries(errors).filter(([, text]) => text));
  return { ok: Object.keys(found).length === 0, errors: found, values };
}

export function validateSignIn({ email, password }) {
  return collect(
    {
      email: validateEmail(email),
      password: password ? '' : 'Informe a senha.',
    },
    { email: String(email ?? '').trim(), password },
  );
}

export function validateSignUp({ fullName, email, password, confirm, role }) {
  return collect(
    {
      fullName: validateFullName(fullName),
      email: validateEmail(email),
      password: validateNewPassword(password),
      confirm: password === confirm ? '' : 'As senhas não são iguais.',
      role: role === 'aluno' || role === 'professor' ? '' : 'Escolha aluno ou professor.',
    },
    {
      fullName: String(fullName ?? '')
        .trim()
        .replace(/\s+/g, ' '),
      email: String(email ?? '').trim(),
      password,
      role,
    },
  );
}

export function validateNewPasswordForm({ code, password, confirm }) {
  return collect(
    {
      code: validateCode(code),
      password: validateNewPassword(password),
      confirm: password === confirm ? '' : 'As senhas não são iguais.',
    },
    { code, password },
  );
}

// O campo do código só aceita números, até o tamanho do código (cola "123 456" e vira 123456).
export function formatCodeInput(raw) {
  return String(raw ?? '')
    .replace(/\D/g, '')
    .slice(0, CODE_LENGTH);
}

// Segundos que faltam até poder pedir outro código.
export function resendSecondsLeft(sentAt, now, wait = RESEND_WAIT_SECONDS) {
  const left = Math.ceil((sentAt + wait * 1000 - now) / 1000);
  return Math.max(0, Math.min(wait, left));
}

export function isCapsLockOn(event) {
  return Boolean(
    event && typeof event.getModifierState === 'function' && event.getModifierState('CapsLock'),
  );
}

// ---- pedidos de professor -----------------------------------------------------------------

export function formatRequestedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
