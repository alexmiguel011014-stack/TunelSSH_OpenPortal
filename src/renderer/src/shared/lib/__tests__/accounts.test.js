import { describe, expect, it } from 'vitest';
import {
  accountBanner,
  canSee,
  formatCodeInput,
  isCapsLockOn,
  landingScreen,
  resendSecondsLeft,
  resolveAccount,
  roleLabel,
  validateCode,
  validateEmail,
  validateNewPassword,
  validateNewPasswordForm,
  validateSignIn,
  validateSignUp,
} from '../accounts.js';

const profile = (extra = {}) => ({
  id: 'u1',
  email: 'ana@escola.com',
  fullName: 'Ana Souza',
  role: 'aluno',
  teacherPending: false,
  ...extra,
});

describe('resolveAccount', () => {
  it('mapeia cada estado do processo principal', () => {
    expect(resolveAccount(null)).toEqual({ kind: 'loading' });
    expect(resolveAccount({ status: 'loading' })).toEqual({ kind: 'loading' });
    expect(resolveAccount({ status: 'unconfigured' })).toEqual({ kind: 'legacy' });
    expect(resolveAccount({ status: 'signed-out', noAccount: false })).toEqual({
      kind: 'signed-out',
    });
    expect(resolveAccount({ status: 'awaiting-code', noAccount: false })).toEqual({
      kind: 'signed-out',
    });
    expect(resolveAccount({ status: 'signed-out', noAccount: true })).toEqual({ kind: 'guest' });
  });

  it('separa aluno, professor pendente e professor, e marca o modo offline', () => {
    expect(resolveAccount({ status: 'signed-in', profile: profile() })).toMatchObject({
      kind: 'student',
      offline: false,
    });
    expect(
      resolveAccount({ status: 'signed-in', profile: profile({ teacherPending: true }) }).kind,
    ).toBe('pending');
    expect(
      resolveAccount({ status: 'signed-in', profile: profile({ role: 'professor' }) }).kind,
    ).toBe('teacher');
    expect(
      resolveAccount({ status: 'offline', profile: profile({ role: 'professor' }) }),
    ).toMatchObject({ kind: 'teacher', offline: true });
  });

  it('conectado sem perfil volta para a tela de entrada, nunca libera o app', () => {
    expect(resolveAccount({ status: 'signed-in', profile: null })).toEqual({ kind: 'signed-out' });
  });

  it('quem entrou ignora "sem conta"', () => {
    expect(resolveAccount({ status: 'signed-in', noAccount: true, profile: profile() }).kind).toBe(
      'student',
    );
  });
});

describe('canSee: a tabela de telas por papel', () => {
  const kinds = ['legacy', 'guest', 'student', 'pending', 'teacher'];
  const screens = ['home', 'access', 'connect', 'files', 'activity', 'lab', 'approvals', 'config'];
  const row = (kind) => screens.filter((screen) => canSee({ kind }, screen));

  it('cada coluna da tabela do GOALS 20', () => {
    expect(row('guest')).toEqual(['home', 'config']);
    expect(row('student')).toEqual(['home', 'access', 'config']);
    expect(row('pending')).toEqual(['home', 'access', 'config']);
    expect(row('teacher')).toEqual([
      'home',
      'connect',
      'files',
      'activity',
      'lab',
      'approvals',
      'config',
    ]);
  });

  it('sem contas no build, nada some e nada novo aparece', () => {
    expect(row('legacy')).toEqual(['home', 'connect', 'files', 'activity', 'lab', 'config']);
  });

  it('só professor aprovado conecta a outros PCs e aprova pedidos', () => {
    for (const kind of kinds) {
      const privileged = kind === 'teacher' || kind === 'legacy';
      expect(canSee({ kind }, 'connect'), kind).toBe(privileged);
      expect(canSee({ kind }, 'approvals'), kind).toBe(kind === 'teacher');
    }
  });

  it('o que não existe não aparece para ninguém', () => {
    expect(canSee({ kind: 'teacher' }, 'inexistente')).toBe(false);
    expect(canSee({ kind: 'signed-out' }, 'home')).toBe(false);
    expect(canSee(null, 'home')).toBe(false);
  });

  it('a tela de abertura e os rótulos', () => {
    expect(landingScreen({ kind: 'student' })).toBe('access');
    expect(landingScreen({ kind: 'pending' })).toBe('access');
    expect(landingScreen({ kind: 'teacher' })).toBe('home');
    expect(landingScreen({ kind: 'guest' })).toBe('home');
    expect(roleLabel({ kind: 'student' })).toBe('Aluno');
    expect(roleLabel({ kind: 'teacher' })).toBe('Professor');
    expect(roleLabel({ kind: 'pending' })).toBe('Professor — aguardando aprovação');
    expect(roleLabel({ kind: 'guest' })).toBe('');
  });
});

describe('accountBanner', () => {
  it('avisa do pedido pendente e da falta de conexão', () => {
    expect(accountBanner({ kind: 'pending' }).tone).toBe('info');
    expect(accountBanner({ kind: 'teacher', offline: true }).tone).toBe('warning');
    expect(accountBanner({ kind: 'student' })).toBeNull();
    expect(accountBanner({ kind: 'legacy' })).toBeNull();
  });
});

describe('validação dos formulários', () => {
  it('e-mail', () => {
    expect(validateEmail('ana@escola.com')).toBe('');
    expect(validateEmail('  ana@escola.com ')).toBe('');
    expect(validateEmail('')).toBe('Informe o e-mail.');
    expect(validateEmail('ana@')).toBe('Confira o e-mail digitado.');
  });

  it('senha nova: tamanho, letras e números', () => {
    expect(validateNewPassword('Senha1234')).toBe('');
    expect(validateNewPassword('curta1')).toMatch(/pelo menos 8/);
    expect(validateNewPassword('somenteletras')).toMatch(/letras e números/);
    expect(validateNewPassword('123456789')).toMatch(/letras e números/);
    expect(validateNewPassword(`a1${'x'.repeat(71)}`)).toMatch(/no máximo 72/);
  });

  it('entrar', () => {
    expect(validateSignIn({ email: 'ana@escola.com', password: 'x' }).ok).toBe(true);
    const bad = validateSignIn({ email: '', password: '' });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors)).toEqual(['email', 'password']);
  });

  it('criar conta: limpa o nome e o e-mail, confere a confirmação e o papel', () => {
    const good = validateSignUp({
      fullName: '  Ana   Souza ',
      email: ' ana@escola.com ',
      password: 'Senha1234',
      confirm: 'Senha1234',
      role: 'professor',
    });
    expect(good).toEqual({
      ok: true,
      errors: {},
      values: {
        fullName: 'Ana Souza',
        email: 'ana@escola.com',
        password: 'Senha1234',
        role: 'professor',
      },
    });

    const bad = validateSignUp({
      fullName: '',
      email: 'x',
      password: 'curta',
      confirm: 'outra',
      role: 'admin',
    });
    expect(Object.keys(bad.errors)).toEqual(['fullName', 'email', 'password', 'confirm', 'role']);
    expect(bad.ok).toBe(false);
  });

  it('código e senha nova da recuperação', () => {
    expect(validateCode('123456')).toBe('');
    expect(validateCode('12345')).toMatch(/6 números/);
    expect(validateCode('abcdef')).toMatch(/6 números/);
    expect(
      validateNewPasswordForm({ code: '123456', password: 'Senha1234', confirm: 'Senha1234' }).ok,
    ).toBe(true);
    expect(
      Object.keys(
        validateNewPasswordForm({ code: '1', password: 'Senha1234', confirm: 'x' }).errors,
      ),
    ).toEqual(['code', 'confirm']);
  });

  it('o campo do código só guarda números, até 6', () => {
    expect(formatCodeInput('123 456')).toBe('123456');
    expect(formatCodeInput('12ab34')).toBe('1234');
    expect(formatCodeInput('1234567890')).toBe('123456');
    expect(formatCodeInput(null)).toBe('');
  });

  it('contagem para reenviar o código', () => {
    const sent = 1_000_000;
    expect(resendSecondsLeft(sent, sent)).toBe(60);
    expect(resendSecondsLeft(sent, sent + 59_001)).toBe(1);
    expect(resendSecondsLeft(sent, sent + 60_000)).toBe(0);
    expect(resendSecondsLeft(sent, sent + 999_999)).toBe(0);
    expect(resendSecondsLeft(sent, sent - 5_000)).toBe(60);
  });

  it('detecta Caps Lock', () => {
    expect(isCapsLockOn({ getModifierState: (key) => key === 'CapsLock' })).toBe(true);
    expect(isCapsLockOn({ getModifierState: () => false })).toBe(false);
    expect(isCapsLockOn({})).toBe(false);
    expect(isCapsLockOn(null)).toBe(false);
  });
});
