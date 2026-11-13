import { describe, expect, it } from 'vitest';
import { UAC_DENIED, buildInstallCommand, registerPrerequisitesIpc } from '../prerequisites-ipc.js';

const SCRIPT = 'C:\\Program Files\\OpenPortal Remote\\resources\\prereqs\\install-prereq.ps1';

function memoryFs() {
  const state = { dirs: new Map(), removed: [], files: {} };
  return {
    state,
    mkdtempSync: (prefix) => {
      const dir = `${prefix}ABC123`;
      state.dirs.set(dir, true);
      return dir;
    },
    readFileSync: (file) => {
      if (!(file in state.files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return state.files[file];
    },
    rmSync: (dir) => state.removed.push(dir),
    existsSync: (file) => file in state.files,
  };
}

function setup(overrides = {}) {
  const handlers = {};
  const fs = overrides.fs || memoryFs();
  const calls = { elevated: [], spawn: [], detect: 0 };
  registerPrerequisitesIpc({
    ipcMain: { handle: (channel, handler) => (handlers[channel] = handler) },
    scriptPath: SCRIPT,
    fs,
    os: { tmpdir: () => 'C:\\Temp' },
    path: { join: (...parts) => parts.join('\\') },
    detect: async () => {
      calls.detect += 1;
      return { tailscale: { state: 'running' }, detectedAt: calls.detect };
    },
    runElevated: async (command) => {
      calls.elevated.push(command);
      if (overrides.runElevated) return overrides.runElevated(command, fs);
    },
    spawn: (...args) => {
      calls.spawn.push(args);
      if (overrides.spawn) return overrides.spawn(...args);
      return { unref() {} };
    },
    guiPath: 'C:\\Program Files\\Tailscale\\tailscale-ipn.exe',
  });
  return { handlers, fs, calls };
}

const resultFileOf = (command) => /-ResultFile '([^']+)'/.exec(command)[1];

describe('prereqs:get', () => {
  it('devolve a detecção', async () => {
    const { handlers } = setup();
    expect(await handlers['prereqs:get']()).toMatchObject({ tailscale: { state: 'running' } });
  });
});

describe('buildInstallCommand', () => {
  it('roda o script em arquivo, sem a política padrão, e devolve o código dele', () => {
    const command = buildInstallCommand({
      scriptPath: "C:\\Users\\O'Neil\\install-prereq.ps1",
      name: 'tailscale',
      resultFile: 'C:\\Temp\\x\\result.json',
    });
    expect(command).toContain(
      "-ExecutionPolicy Bypass -File 'C:\\Users\\O''Neil\\install-prereq.ps1'",
    );
    expect(command).toContain('-Name tailscale');
    expect(command).toContain("-ResultFile 'C:\\Temp\\x\\result.json'");
    expect(command.endsWith('exit $LASTEXITCODE')).toBe(true);
  });
});

describe('prereqs:install', () => {
  it.each([undefined, null, 42, '', 'chrome', 'tailscale; calc', 'TAILSCALE', '../tightvnc', {}])(
    'recusa o nome %j sem rodar nada',
    async (name) => {
      const { handlers, calls } = setup();
      const result = await handlers['prereqs:install']({}, name);
      expect(result.success).toBe(false);
      expect(calls.elevated).toHaveLength(0);
    },
  );

  it('instala e devolve a mensagem do script e a nova detecção', async () => {
    const { handlers, calls } = setup({
      runElevated: (command, fs) => {
        fs.state.files[resultFileOf(command)] = JSON.stringify({
          ok: true,
          code: 0,
          restartNeeded: false,
          message: 'Tailscale instalado.',
        });
      },
    });
    const result = await handlers['prereqs:install']({}, 'tailscale');
    expect(result).toMatchObject({
      success: true,
      restartNeeded: false,
      message: 'Tailscale instalado.',
      prerequisites: { tailscale: { state: 'running' } },
    });
    expect(calls.elevated[0]).toContain('-Name tailscale');
    expect(calls.elevated[0]).toContain(`-File '${SCRIPT}'`);
  });

  it('repassa o pedido de reinício', async () => {
    const { handlers } = setup({
      runElevated: (command, fs) => {
        fs.state.files[resultFileOf(command)] = JSON.stringify({
          ok: true,
          code: 3010,
          restartNeeded: true,
          message: 'TightVNC instalado. O Windows pede para reiniciar o computador.',
        });
      },
    });
    const result = await handlers['prereqs:install']({}, 'tightvnc');
    expect(result.success).toBe(true);
    expect(result.restartNeeded).toBe(true);
  });

  it('a falha do script chega como erro, com o texto dele', async () => {
    const { handlers } = setup({
      runElevated: (command, fs) => {
        fs.state.files[resultFileOf(command)] = JSON.stringify({
          ok: false,
          code: 0,
          restartNeeded: false,
          message: 'Não foi possível baixar o Tailscale. Confira a conexão com a internet.',
        });
      },
    });
    const result = await handlers['prereqs:install']({}, 'tailscale');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Não foi possível baixar');
    expect(result).not.toHaveProperty('message');
  });

  it('o UAC recusado vira o aviso de permissão e ainda reconfere o estado', async () => {
    const { handlers, calls } = setup({
      runElevated: () => {
        throw new Error('PowerShell elevado saiu com código 1');
      },
    });
    const result = await handlers['prereqs:install']({}, 'tailscale');
    expect(result).toMatchObject({ success: false, error: UAC_DENIED });
    expect(result.prerequisites).toBeTruthy();
    expect(calls.detect).toBe(1);
  });

  it('sem arquivo de resultado, a instalação não é dada como feita', async () => {
    const { handlers } = setup();
    const result = await handlers['prereqs:install']({}, 'tightvnc');
    expect(result.success).toBe(false);
    expect(result.error).toContain('não deixou resultado');
  });

  it('um arquivo de resultado quebrado também falha', async () => {
    const { handlers } = setup({
      runElevated: (command, fs) => {
        fs.state.files[resultFileOf(command)] = '{ não é json';
      },
    });
    const result = await handlers['prereqs:install']({}, 'tailscale');
    expect(result.success).toBe(false);
  });

  it('apaga a pasta temporária em qualquer desfecho', async () => {
    const ok = setup({
      runElevated: (command, fs) => {
        fs.state.files[resultFileOf(command)] = JSON.stringify({ ok: true });
      },
    });
    await ok.handlers['prereqs:install']({}, 'tailscale');
    expect(ok.fs.state.removed).toEqual(['C:\\Temp\\openportal-prereq-ABC123']);

    const refused = setup({
      runElevated: () => {
        throw new Error('uac');
      },
    });
    await refused.handlers['prereqs:install']({}, 'tailscale');
    expect(refused.fs.state.removed).toHaveLength(1);
  });

  it('só uma instalação por vez', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { handlers } = setup({
      runElevated: async (command, fs) => {
        await gate;
        fs.state.files[resultFileOf(command)] = JSON.stringify({ ok: true });
      },
    });
    const first = handlers['prereqs:install']({}, 'tailscale');
    const second = await handlers['prereqs:install']({}, 'tightvnc');
    expect(second).toMatchObject({ success: false, error: expect.stringContaining('andamento') });
    release();
    expect((await first).success).toBe(true);
    // E depois que termina, uma nova instalação volta a ser aceita.
    const third = await handlers['prereqs:install']({}, 'tightvnc');
    expect(third.success).toBe(true);
  });
});

describe('prereqs:openTailscale', () => {
  it('abre a janela do Tailscale com lista de argumentos, sem shell', async () => {
    const fs = memoryFs();
    fs.state.files['C:\\Program Files\\Tailscale\\tailscale-ipn.exe'] = 'x';
    const { handlers, calls } = setup({ fs });
    expect(await handlers['prereqs:openTailscale']()).toEqual({ success: true });
    expect(calls.spawn).toHaveLength(1);
    const [file, args, options] = calls.spawn[0];
    expect(file).toBe('C:\\Program Files\\Tailscale\\tailscale-ipn.exe');
    expect(args).toEqual([]);
    expect(options.shell).toBeUndefined();
    expect(options.detached).toBe(true);
  });

  it('sem o programa instalado, diz isso em vez de tentar abrir', async () => {
    const { handlers, calls } = setup();
    const result = await handlers['prereqs:openTailscale']();
    expect(result.success).toBe(false);
    expect(calls.spawn).toHaveLength(0);
  });

  it('uma falha ao abrir vira erro, sem lançar', async () => {
    const fs = memoryFs();
    fs.state.files['C:\\Program Files\\Tailscale\\tailscale-ipn.exe'] = 'x';
    const { handlers } = setup({
      fs,
      spawn: () => {
        throw new Error('EACCES');
      },
    });
    const result = await handlers['prereqs:openTailscale']();
    expect(result.success).toBe(false);
    expect(result.error).toContain('EACCES');
  });
});
