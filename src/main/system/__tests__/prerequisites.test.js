import { describe, expect, it } from 'vitest';
import {
  TAILSCALE_CLI,
  detectHost,
  detectPrerequisites,
  detectTailscale,
  parseHostProbe,
  parseTailscaleState,
  rdpHostingFor,
  tightVncStateFrom,
} from '../prerequisites.js';

// execFile falso: cada binário responde conforme o mapa. { json } = saída; { code } = erro com
// esse código (ENOENT = não existe); { hang: true } = o timeout do Node matou o processo.
function fakeExecFile(behaviors, calls = []) {
  return (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    const behavior = behaviors[binary] || { code: 'ENOENT' };
    setImmediate(() => {
      if (behavior.json !== undefined) return callback(null, JSON.stringify(behavior.json));
      if (behavior.raw !== undefined) return callback(null, behavior.raw);
      if (behavior.hang) return callback(Object.assign(new Error('timeout'), { killed: true }), '');
      return callback(Object.assign(new Error('falhou'), { code: behavior.code }), '');
    });
  };
}

describe('parseTailscaleState', () => {
  it.each([
    ['Running', 'running'],
    ['NeedsLogin', 'needs-login'],
    ['NeedsMachineAuth', 'needs-login'],
    ['Stopped', 'stopped'],
    ['Starting', 'stopped'],
    ['NoState', 'stopped'],
    [undefined, 'stopped'],
  ])('BackendState %s -> %s', (backend, expected) => {
    expect(parseTailscaleState({ BackendState: backend })).toBe(expected);
  });

  it('um JSON sem nada também é parado', () => {
    expect(parseTailscaleState(null)).toBe('stopped');
  });
});

describe('detectTailscale', () => {
  it('conectado: o `tailscale status --json` do PATH diz Running', async () => {
    const calls = [];
    const result = await detectTailscale({
      execFile: fakeExecFile({ tailscale: { json: { BackendState: 'Running' } } }, calls),
      existsSync: () => false,
    });
    expect(result).toEqual({ state: 'running' });
    expect(calls[0]).toMatchObject({
      binary: 'tailscale',
      args: ['status', '--json'],
      options: { timeout: 5000, windowsHide: true },
    });
  });

  it('precisa entrar na conta', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({ tailscale: { json: { BackendState: 'NeedsLogin' } } }),
      existsSync: () => false,
    });
    expect(result.state).toBe('needs-login');
  });

  it('a CLI fora do PATH, mas no caminho padrão, ainda é achada', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({ [TAILSCALE_CLI]: { json: { BackendState: 'Running' } } }),
      existsSync: (file) => file === TAILSCALE_CLI,
    });
    expect(result.state).toBe('running');
  });

  it('o serviço parado: o executável existe mas não responde', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({ tailscale: { code: 1 } }),
      existsSync: () => false,
    });
    expect(result.state).toBe('stopped');
  });

  it('um executável que trava (timeout) vira parado, sem lançar', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({ tailscale: { hang: true } }),
      existsSync: () => false,
    });
    expect(result.state).toBe('stopped');
  });

  it('uma saída que não é JSON vira parado', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({ tailscale: { raw: 'Tailscale is stopped.' } }),
      existsSync: () => false,
    });
    expect(result.state).toBe('stopped');
  });

  it('sem executável em lugar nenhum, falta o Tailscale', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({}),
      existsSync: () => false,
    });
    expect(result.state).toBe('missing');
  });

  it('só o arquivo no caminho padrão, sem a CLI responder, conta como instalado e parado', async () => {
    const result = await detectTailscale({
      execFile: fakeExecFile({}),
      existsSync: (file) => file === TAILSCALE_CLI,
    });
    expect(result.state).toBe('stopped');
  });
});

describe('parseHostProbe', () => {
  it('lê serviço, versão e edição', () => {
    expect(parseHostProbe('svc=Running|ver=2.8.90.0|edition=Professional')).toEqual({
      service: 'running',
      version: '2.8.90.0',
      edition: 'Professional',
    });
  });

  it('serviço parado, sem versão e sem edição', () => {
    expect(parseHostProbe('svc=Stopped|ver=|edition=')).toEqual({
      service: 'stopped',
      version: '',
      edition: '',
    });
  });

  it('saída vazia ou estranha não lança', () => {
    expect(parseHostProbe('')).toEqual({ service: '', version: '', edition: '' });
    expect(parseHostProbe(undefined)).toEqual({ service: '', version: '', edition: '' });
    expect(parseHostProbe('lixo sem campos')).toEqual({ service: '', version: '', edition: '' });
  });
});

describe('tightVncStateFrom', () => {
  it('2.x com o serviço rodando ou parado', () => {
    expect(tightVncStateFrom({ service: 'running', version: '2.8.90.0' }).state).toBe('running');
    expect(tightVncStateFrom({ service: 'stopped', version: '2.8.63.0' }).state).toBe('stopped');
  });

  it('o serviço sem versão legível ainda conta como TightVNC 2', () => {
    expect(tightVncStateFrom({ service: 'running', version: '' }).state).toBe('running');
  });

  it('o TightVNC 4 não é o que o app configura', () => {
    expect(tightVncStateFrom({ service: 'running', version: '4.0.0' })).toEqual({
      state: 'unsupported',
      version: '4.0.0',
    });
    expect(tightVncStateFrom({ service: '', version: '4.0.0' }).state).toBe('unsupported');
  });

  it('sem serviço (só o visualizador) ou sem nada, falta', () => {
    expect(tightVncStateFrom({ service: '', version: '2.8.90.0' }).state).toBe('missing');
    expect(tightVncStateFrom({ service: '', version: '' }).state).toBe('missing');
  });
});

describe('rdpHostingFor', () => {
  it.each([
    ['Professional', true],
    ['Enterprise', true],
    ['Education', true],
    ['ProfessionalWorkstation', true],
    ['Core', false],
    ['CoreN', false],
    ['CoreSingleLanguage', false],
    ['', null],
  ])('%s -> %s', (edition, expected) => {
    expect(rdpHostingFor(edition)).toBe(expected);
  });
});

describe('detectHost e detectPrerequisites', () => {
  const probe = (output) => ({ readPowerShell: async () => output });

  it('junta TightVNC e edição de uma consulta só', async () => {
    const host = await detectHost(probe('svc=Running|ver=2.8.90.0|edition=Core'));
    expect(host).toEqual({
      tightvnc: { state: 'running', version: '2.8.90.0' },
      windows: { edition: 'Core', rdpHosting: false },
    });
  });

  it('devolve os três blocos e o horário', async () => {
    const result = await detectPrerequisites({
      execFile: fakeExecFile({ tailscale: { json: { BackendState: 'Running' } } }),
      existsSync: () => false,
      ...probe('svc=|ver=|edition=Professional'),
    });
    expect(result.tailscale).toEqual({ state: 'running' });
    expect(result.tightvnc.state).toBe('missing');
    expect(result.windows).toEqual({ edition: 'Professional', rdpHosting: true });
    expect(typeof result.checkedAt).toBe('number');
  });

  it('se o PowerShell cai, o TightVNC fica desconhecido e nada lança', async () => {
    const result = await detectPrerequisites({
      execFile: fakeExecFile({ tailscale: { json: { BackendState: 'Running' } } }),
      existsSync: () => false,
      readPowerShell: async () => {
        throw new Error('sem powershell');
      },
    });
    expect(result.tailscale.state).toBe('running');
    expect(result.tightvnc.state).toBe('unknown');
    expect(result.windows.rdpHosting).toBeNull();
  });

  it('se o Tailscale cai de forma inesperada, fica desconhecido', async () => {
    const result = await detectPrerequisites({
      execFile: () => {
        throw new Error('boom');
      },
      existsSync: () => {
        throw new Error('boom');
      },
      ...probe(''),
    });
    expect(result.tailscale.state).toBe('unknown');
  });
});
