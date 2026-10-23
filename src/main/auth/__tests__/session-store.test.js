import { describe, expect, it } from 'vitest';
import { createSessionStore } from '../session-store.js';

// Um "cofre" falso e reversível: o texto cifrado não contém o original, mas volta a ele.
function fakeSafeStorage({ available = true } = {}) {
  const scramble = (buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => scramble(Buffer.from(text, 'utf8')),
    decryptString: (buffer) => scramble(buffer).toString('utf8'),
  };
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync: (file, data) => files.set(file, String(data)),
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmSync: (file) => files.delete(file),
    mkdirSync: () => {},
  };
}

const FILE = 'userData/auth-session.json';
const SESSION = JSON.stringify({ access_token: 'access-AAA', refresh_token: 'refresh-BBB' });

describe('session store', () => {
  it('guarda a sessão cifrada: o arquivo não tem o token em texto puro', () => {
    const fs = memoryFs();
    const store = createSessionStore({ file: FILE, safeStorage: fakeSafeStorage(), fs });
    store.setItem('sb-auth', SESSION);

    const onDisk = fs.files.get(FILE);
    expect(onDisk).toBeTruthy();
    expect(onDisk).not.toContain('refresh-BBB');
    expect(onDisk).not.toContain('access-AAA');
    expect([...fs.files.keys()]).toEqual([FILE]); // sem arquivo temporário sobrando
  });

  it('um novo store lê de volta o que foi guardado; remover apaga o arquivo no fim', () => {
    const fs = memoryFs();
    const first = createSessionStore({ file: FILE, safeStorage: fakeSafeStorage(), fs });
    first.setItem('a', '1');
    first.setItem('b', '2');

    const second = createSessionStore({ file: FILE, safeStorage: fakeSafeStorage(), fs });
    expect(second.getItem('a')).toBe('1');
    expect(second.getItem('b')).toBe('2');
    expect(second.getItem('nada')).toBeNull();

    second.removeItem('a');
    second.removeItem('b');
    expect(fs.files.has(FILE)).toBe(false);
  });

  it('sem o cofre do sistema fica só na memória: nenhum arquivo é escrito e um antigo é apagado', () => {
    const fs = memoryFs();
    fs.files.set(FILE, '{"v":1,"enc":"sobrou"}');
    const store = createSessionStore({
      file: FILE,
      safeStorage: fakeSafeStorage({ available: false }),
      fs,
    });
    expect(store.getItem('a')).toBeNull();
    store.setItem('a', SESSION);
    expect(store.getItem('a')).toBe(SESSION);
    expect(fs.files.has(FILE)).toBe(false);
    expect(store.isPersistent()).toBe(false);
  });

  it('arquivo ilegível, adulterado ou de outro formato vale como "sem sessão"', () => {
    for (const content of [
      'não é json',
      '{"v":2,"enc":"x"}',
      '{"v":1}',
      JSON.stringify({ v: 1, enc: Buffer.from('lixo').toString('base64') }),
      JSON.stringify({ v: 1, enc: fakeSafeStorage().encryptString('[1,2]').toString('base64') }),
    ]) {
      const fs = memoryFs();
      fs.files.set(FILE, content);
      const logs = [];
      const store = createSessionStore({
        file: FILE,
        safeStorage: fakeSafeStorage(),
        fs,
        log: (line) => logs.push(line),
      });
      expect(store.getItem('a'), content).toBeNull();
      // e continua utilizável depois
      store.setItem('a', '1');
      expect(store.getItem('a')).toBe('1');
    }
  });

  it('falha ao gravar não derruba a sessão em memória', () => {
    const fs = memoryFs();
    fs.writeFileSync = () => {
      throw new Error('disco cheio');
    };
    const logs = [];
    const store = createSessionStore({
      file: FILE,
      safeStorage: fakeSafeStorage(),
      fs,
      log: (line) => logs.push(line),
    });
    store.setItem('a', '1');
    expect(store.getItem('a')).toBe('1');
    expect(logs.join('\n')).toContain('disco cheio');
  });

  it('sem arquivo configurado funciona só na memória', () => {
    const store = createSessionStore({ file: null, safeStorage: fakeSafeStorage() });
    store.setItem('a', '1');
    expect(store.getItem('a')).toBe('1');
  });
});
