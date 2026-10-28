import { describe, expect, it } from 'vitest';
import { canSee } from '../accounts';
import {
  PREREQUISITE_NAMES,
  describePrerequisites,
  gateFor,
  needsAttention,
  vncNoteFor,
} from '../requirements';

const prereqs = (tailscale, tightvnc = 'running', windows = {}) => ({
  tailscale: { state: tailscale },
  tightvnc: { state: tightvnc, version: '2.8.90.0' },
  windows: { edition: 'Professional', rdpHosting: true, ...windows },
});

// As telas que dependem do Tailscale ligado neste PC (a tabela do GOALS 22).
const NEEDS_TAILSCALE = ['connect', 'lab', 'files', 'receive'];
// Telas que só precisam de internet: nunca bloqueadas.
const NEVER_GATED = ['home', 'access', 'account', 'approvals', 'activity', 'config'];

describe('gateFor', () => {
  it('com o Tailscale ligado nada é bloqueado', () => {
    for (const screen of [...NEEDS_TAILSCALE, ...NEVER_GATED]) {
      expect(gateFor({ screen, prerequisites: prereqs('running') }), screen).toBeNull();
    }
  });

  it.each([
    ['missing', 'tailscale-missing', ['install-tailscale', 'recheck']],
    ['stopped', 'tailscale-stopped', ['open-tailscale', 'recheck']],
    ['needs-login', 'tailscale-login', ['open-tailscale', 'recheck']],
  ])('Tailscale %s barra conectar, laboratório, arquivos e receber', (state, kind, actions) => {
    for (const screen of NEEDS_TAILSCALE) {
      const gate = gateFor({ screen, prerequisites: prereqs(state) });
      expect(gate?.kind, screen).toBe(kind);
      expect(gate.actions, screen).toEqual(actions);
      expect(gate.title).toBeTruthy();
      expect(gate.message).toBeTruthy();
    }
  });

  it('sem o Tailscale, entrar, Meu acesso, Aprovações, Atividade e Configurações seguem livres', () => {
    for (const screen of NEVER_GATED) {
      expect(gateFor({ screen, prerequisites: prereqs('missing') }), screen).toBeNull();
    }
  });

  it("'unknown' e uma leitura que ainda não veio nunca bloqueiam", () => {
    for (const screen of NEEDS_TAILSCALE) {
      expect(gateFor({ screen, prerequisites: prereqs('unknown') }), screen).toBeNull();
      expect(gateFor({ screen, prerequisites: null }), screen).toBeNull();
      expect(gateFor({ screen, prerequisites: undefined }), screen).toBeNull();
      expect(gateFor({ screen, prerequisites: {} }), screen).toBeNull();
    }
  });

  it('o TightVNC faltando não barra nenhuma tela (só o aviso do cartão Este PC)', () => {
    for (const screen of [...NEEDS_TAILSCALE, ...NEVER_GATED]) {
      expect(gateFor({ screen, prerequisites: prereqs('running', 'missing') }), screen).toBeNull();
    }
  });
});

describe('quem vê o quê (por papel) com o Tailscale faltando', () => {
  const missing = prereqs('missing');
  const gated = (account) =>
    ['connect', 'lab', 'files']
      .filter((screen) => canSee(account, screen))
      .filter((screen) => gateFor({ screen, prerequisites: missing }));

  it('o professor tem conectar, laboratório e arquivos bloqueados', () => {
    expect(gated({ kind: 'teacher' })).toEqual(['connect', 'lab', 'files']);
  });

  it('o build sem contas (modo antigo) também', () => {
    expect(gated({ kind: 'legacy' })).toEqual(['connect', 'lab', 'files']);
  });

  it('o aluno e o professor pendente não têm essas telas, então nada para bloquear', () => {
    expect(gated({ kind: 'student' })).toEqual([]);
    expect(gated({ kind: 'pending' })).toEqual([]);
  });

  it('quem usa sem conta só vê a tela inicial: o cartão Este PC avisa, nada é bloqueado', () => {
    expect(gated({ kind: 'guest' })).toEqual([]);
    expect(gateFor({ screen: 'receive', prerequisites: missing })?.kind).toBe('tailscale-missing');
  });

  it('Meu acesso do aluno nunca é bloqueado', () => {
    expect(canSee({ kind: 'student' }, 'access')).toBe(true);
    expect(gateFor({ screen: 'access', prerequisites: missing })).toBeNull();
  });
});

describe('vncNoteFor', () => {
  it('TightVNC faltando: oferece instalar e cita o RDP quando o Windows recebe RDP', () => {
    const note = vncNoteFor({ prerequisites: prereqs('running', 'missing', { rdpHosting: true }) });
    expect(note.kind).toBe('tightvnc-missing');
    expect(note.actions).toEqual(['install-tightvnc', 'recheck']);
    expect(note.message).toContain('RDP');
    expect(note.message).toContain('sem o TightVNC');
  });

  it('no Windows Home, avisa que o RDP não é alternativa', () => {
    const note = vncNoteFor({
      prerequisites: prereqs('running', 'missing', { edition: 'Core', rdpHosting: false }),
    });
    expect(note.message).toContain('Home');
    expect(note.message).not.toContain('ligue-o em Configurações');
  });

  it('edição desconhecida: não afirma nada sobre o RDP', () => {
    const note = vncNoteFor({ prerequisites: prereqs('running', 'missing', { rdpHosting: null }) });
    expect(note.message).not.toContain('Home');
    expect(note.message).not.toContain('Configurações');
  });

  it('TightVNC 4: explica que o app usa o 2 e não oferece instalar por cima', () => {
    const note = vncNoteFor({ prerequisites: prereqs('running', 'unsupported') });
    expect(note.kind).toBe('tightvnc-unsupported');
    expect(note.message).toContain('TightVNC 2');
    expect(note.actions).toEqual(['recheck']);
  });

  it('TightVNC parado', () => {
    expect(vncNoteFor({ prerequisites: prereqs('running', 'stopped') }).kind).toBe(
      'tightvnc-stopped',
    );
  });

  it('rodando, desconhecido ou sem leitura: sem aviso', () => {
    expect(vncNoteFor({ prerequisites: prereqs('running', 'running') })).toBeNull();
    expect(vncNoteFor({ prerequisites: prereqs('running', 'unknown') })).toBeNull();
    expect(vncNoteFor({ prerequisites: null })).toBeNull();
  });
});

describe('describePrerequisites e needsAttention', () => {
  it('lista os dois programas, o Tailscale obrigatório e o TightVNC opcional', () => {
    const rows = describePrerequisites(prereqs('needs-login', 'missing'));
    expect(rows.map((row) => row.name)).toEqual(PREREQUISITE_NAMES);
    expect(rows[0]).toMatchObject({ required: true, state: 'needs-login', tone: 'warning' });
    expect(rows[1]).toMatchObject({ required: false, state: 'missing', tone: 'missing' });
  });

  it('sem leitura, as duas linhas ficam "não foi possível verificar"', () => {
    const rows = describePrerequisites(null);
    expect(rows.every((row) => row.tone === 'unknown')).toBe(true);
  });

  it('a tela de primeira abertura só aparece quando algo falta ou está parado', () => {
    expect(needsAttention(prereqs('running', 'running'))).toBe(false);
    expect(needsAttention(prereqs('missing', 'running'))).toBe(true);
    expect(needsAttention(prereqs('stopped', 'running'))).toBe(true);
    expect(needsAttention(prereqs('needs-login', 'running'))).toBe(true);
    expect(needsAttention(prereqs('running', 'missing'))).toBe(true);
    expect(needsAttention(prereqs('running', 'unsupported'))).toBe(true);
    expect(needsAttention(prereqs('unknown', 'unknown'))).toBe(false);
    expect(needsAttention(null)).toBe(false);
  });
});
