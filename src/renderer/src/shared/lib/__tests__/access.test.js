import { describe, expect, it } from 'vitest';
import {
  describeLink,
  describeMyAccess,
  describePublication,
  indexLinks,
  isAccessActive,
  isTailscaleAddress,
} from '../access.js';
import { DEFAULT_CREDENTIAL_NOTICE, SESSION_END_HINT } from '../lab.js';

const T = (h, m) => Date.UTC(2026, 9, 22, h, m);
const access = (extra = {}) => ({
  id: 'h-1',
  hostName: 'PC 1',
  address: '100.64.0.7',
  userName: 'PC1\\ana',
  password: 'Xk29-pass-77',
  startBy: T(15, 30),
  endsAt: T(17, 0),
  ...extra,
});

describe('isAccessActive', () => {
  it('vale até o horário de término e some nele', () => {
    expect(isAccessActive(access(), T(16, 59))).toBe(true);
    expect(isAccessActive(access(), T(17, 0))).toBe(false);
    expect(isAccessActive(access(), T(18, 0))).toBe(false);
    expect(isAccessActive(null)).toBe(false);
    expect(isAccessActive({ endsAt: 'ontem' })).toBe(false);
  });
});

describe('isTailscaleAddress', () => {
  it('só a faixa 100.64.0.0/10', () => {
    for (const ok of ['100.64.0.1', '100.127.255.254', ' 100.100.1.1 ']) {
      expect(isTailscaleAddress(ok), ok).toBe(true);
    }
    for (const bad of ['100.63.0.1', '100.128.0.1', '192.168.0.5', 'pc-01', '', null, '100.64.0']) {
      expect(isTailscaleAddress(bad), String(bad)).toBe(false);
    }
  });
});

describe('describeMyAccess', () => {
  it('monta as linhas do cartão com os horários e o tempo que falta', () => {
    const card = describeMyAccess(access(), T(15, 0), 'UTC');
    expect(card).toMatchObject({
      pcName: 'PC 1',
      address: '100.64.0.7',
      userName: 'PC1\\ana',
      startLine: 'Comece até 15:30',
      endLine: 'Válido até 17:00 (faltam 2 h)',
      notice: DEFAULT_CREDENTIAL_NOTICE,
      endHint: SESSION_END_HINT,
    });
    expect(card.tailscaleHint).toMatch(/Tailscale/);
    expect(card).not.toHaveProperty('password');
  });

  it('depois do prazo para começar, não pede mais para começar', () => {
    expect(describeMyAccess(access(), T(15, 45), 'UTC').startLine).toBe('');
    expect(describeMyAccess(access({ startBy: null }), T(15, 0), 'UTC').startLine).toBe('');
  });

  it('endereço fora do Tailscale não leva o aviso do Tailscale', () => {
    expect(
      describeMyAccess(access({ address: '192.168.0.7' }), T(15, 0), 'UTC').tailscaleHint,
    ).toBe('');
  });

  it('o tempo que falta diminui e o cartão some no término', () => {
    expect(describeMyAccess(access(), T(16, 35), 'UTC').endLine).toContain('faltam 25 min');
    expect(describeMyAccess(access(), T(16, 59), 'UTC').endLine).toContain('faltam 1 min');
    expect(describeMyAccess(access(), T(17, 0), 'UTC')).toBeNull();
    expect(describeMyAccess(null)).toBeNull();
  });
});

describe('describePublication', () => {
  it('enviado: a frase do processo principal', () => {
    expect(describePublication({ status: 'sent', message: 'Enviado para o app de Ana' })).toEqual({
      tone: 'ok',
      text: 'Enviado para o app de Ana',
    });
  });

  it('sem conta vinculada: aviso, e o professor segue com a mensagem copiada', () => {
    expect(
      describePublication({
        status: 'skipped',
        message: 'ana não tem conta vinculada: use Copiar mensagem',
      }),
    ).toEqual({ tone: 'warn', text: 'ana não tem conta vinculada: use Copiar mensagem' });
  });

  it('falhou: diz o motivo e manda usar Copiar mensagem', () => {
    const line = describePublication({
      status: 'failed',
      message: 'Sem conexão com o servidor de contas',
    });
    expect(line.tone).toBe('warn');
    expect(line.text).toBe(
      'Não foi enviado ao app do aluno (Sem conexão com o servidor de contas) — use Copiar mensagem',
    );
  });

  it('nada a dizer', () => {
    expect(describePublication(undefined)).toBeNull();
    expect(describePublication({})).toBeNull();
    expect(describePublication({ status: 'sent' })).toBeNull();
  });
});

describe('vínculos', () => {
  it('describeLink e indexLinks', () => {
    expect(describeLink(undefined)).toEqual({ linked: false, text: 'Sem conta no app' });
    expect(describeLink({ email: 'ana@x.com' })).toEqual({ linked: true, text: 'ana@x.com' });
    expect(describeLink({ email: '', fullName: 'Ana' }).text).toBe('Ana');
    expect(indexLinks([{ account: 'ana', email: 'a@x.com' }, { account: 'joao' }])).toEqual({
      ana: { account: 'ana', email: 'a@x.com' },
      joao: { account: 'joao' },
    });
    expect(indexLinks(null)).toEqual({});
  });
});
