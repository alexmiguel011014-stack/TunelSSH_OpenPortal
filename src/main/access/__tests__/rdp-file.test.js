import { describe, expect, it, vi } from 'vitest';
import {
  DELETE_AFTER_MS,
  buildRdpFile,
  cleanAddress,
  cleanUserName,
  createRdpLauncher,
} from '../rdp-file.js';

describe('buildRdpFile', () => {
  it('leva o endereço e o usuário e nunca uma senha', () => {
    const text = buildRdpFile({ address: '100.64.0.7', userName: 'PC1\\ana' });
    expect(text.split('\r\n')).toEqual([
      'full address:s:100.64.0.7',
      'username:s:PC1\\ana',
      'prompt for credentials:i:1',
      'authentication level:i:2',
      'enablecredsspsupport:i:1',
      'screen mode id:i:1',
      '',
    ]);
    expect(text.toLowerCase()).not.toContain('password');
  });

  it('aceita nome de PC, porta e usuário simples', () => {
    expect(buildRdpFile({ address: 'lab-pc-01.escola.local:3390', userName: 'ana' })).toContain(
      'full address:s:lab-pc-01.escola.local:3390',
    );
    expect(cleanUserName('LAB\\joao.silva')).toBe('LAB\\joao.silva');
  });

  it('recusa valores que abririam uma linha de configuração a mais', () => {
    for (const address of [
      '100.64.0.7\r\ndrivestoredirect:s:*',
      '100.64.0.7\ndrivestoredirect:s:*',
      '100.64.0.7 \ndrivestoredirect:s:*',
      '100.64.0.7;evil',
      'a b',
      '',
      '-startswithdash',
      'x'.repeat(300),
      null,
      42,
    ]) {
      expect(cleanAddress(address), String(address)).toBeNull();
      expect(buildRdpFile({ address, userName: 'ana' }), String(address)).toBeNull();
    }
    for (const userName of [
      'ana\r\nredirectclipboard:i:0',
      'ana\nx',
      'a\\b\\c',
      '',
      'ana"',
      'x'.repeat(81),
      null,
    ]) {
      expect(cleanUserName(userName), String(userName)).toBeNull();
      expect(buildRdpFile({ address: '100.64.0.7', userName }), String(userName)).toBeNull();
    }
  });
});

describe('createRdpLauncher', () => {
  function setup(overrides = {}) {
    const files = new Map();
    const child = { on: vi.fn(), unref: vi.fn() };
    const timers = [];
    const spawn = vi.fn(() => child);
    const launcher = createRdpLauncher({
      platform: 'win32',
      tmpdir: () => 'C:\\Temp',
      randomName: () => 'abc123',
      fs: {
        writeFileSync: (file, data) => files.set(file, data),
        rmSync: (file) => files.delete(file),
      },
      spawn,
      setTimeoutFn: (fn, ms) => {
        const timer = { fn, ms, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      ...overrides,
    });
    return { launcher, files, spawn, child, timers };
  }

  it('grava o arquivo, abre o mstsc.exe com uma lista de argumentos (sem shell) e o apaga em 1 minuto', () => {
    const { launcher, files, spawn, child, timers } = setup();
    const result = launcher.open({ address: '100.64.0.7', userName: 'PC1\\ana' });

    expect(result).toEqual({ ok: true });
    const [file] = [...files.keys()];
    expect(file).toMatch(/openportal-abc123\.rdp$/);
    expect(files.get(file)).toContain('full address:s:100.64.0.7');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('mstsc.exe');
    expect(args).toEqual([file]);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(options.shell).toBeUndefined();
    expect(child.unref).toHaveBeenCalled();

    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(DELETE_AFTER_MS);
    timers[0].fn();
    expect(files.size).toBe(0);
  });

  it('dados inválidos não gravam nada nem abrem o mstsc', () => {
    const { launcher, files, spawn } = setup();
    const result = launcher.open({ address: '1.2.3.4\r\nx:s:y', userName: 'ana' });
    expect(result).toMatchObject({ ok: false, error: 'bad-access' });
    expect(files.size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fora do Windows diz que não há como abrir', () => {
    const { launcher, spawn } = setup({ platform: 'linux' });
    expect(launcher.open({ address: '100.64.0.7', userName: 'ana' })).toMatchObject({
      ok: false,
      error: 'unsupported',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('se o mstsc.exe não abrir, o arquivo não fica para trás', () => {
    const { launcher, files } = setup({
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    const result = launcher.open({ address: '100.64.0.7', userName: 'ana' });
    expect(result).toMatchObject({ ok: false, error: 'spawn-failed' });
    expect(result.message).toContain('ENOENT');
    expect(files.size).toBe(0);
  });
});
