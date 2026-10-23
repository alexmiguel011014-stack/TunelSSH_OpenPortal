import { describe, expect, it } from 'vitest';
import { writeAuthConfig } from '../write-auth-config.js';

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv';

function memoryFs(files = {}) {
  const state = { files: { ...files } };
  return {
    state,
    readFileSync(file) {
      if (!(file in state.files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return state.files[file];
    },
    writeFileSync: (file, data) => {
      state.files[file] = String(data);
    },
    rmSync: (file) => {
      delete state.files[file];
    },
  };
}

describe('write-auth-config', () => {
  it('escreve o arquivo gerado a partir das variáveis do ambiente', () => {
    const fsImpl = memoryFs();
    const result = writeAuthConfig({
      env: { SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: KEY_OK },
      envFile: '.env',
      outFile: 'auth-config.json',
      fsImpl,
    });
    expect(result).toEqual({ action: 'written', url: URL_OK });
    expect(JSON.parse(fsImpl.state.files['auth-config.json'])).toEqual({
      url: URL_OK,
      publishableKey: KEY_OK,
    });
  });

  it('usa o .env da raiz quando o ambiente não tem as variáveis', () => {
    const fsImpl = memoryFs({
      '.env': `SUPABASE_URL=${URL_OK}\nSUPABASE_PUBLISHABLE_KEY=${KEY_OK}\n`,
    });
    const result = writeAuthConfig({ env: {}, envFile: '.env', outFile: 'out.json', fsImpl });
    expect(result.action).toBe('written');
  });

  it('sem variáveis não cria o arquivo e apaga um antigo (build sem contas)', () => {
    const fsImpl = memoryFs({ 'out.json': '{"url":"antigo"}' });
    const result = writeAuthConfig({
      env: { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' },
      envFile: '.env',
      outFile: 'out.json',
      fsImpl,
    });
    expect(result).toEqual({ action: 'skipped', reason: 'missing' });
    expect('out.json' in fsImpl.state.files).toBe(false);
  });

  it('a chave secreta derruba o build e nenhum arquivo com ela sobra', () => {
    const fsImpl = memoryFs({ 'out.json': '{"url":"antigo"}' });
    expect(() =>
      writeAuthConfig({
        env: { SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnopqrstuv' },
        envFile: '.env',
        outFile: 'out.json',
        fsImpl,
      }),
    ).toThrow(/chave SECRETA/);
    expect('out.json' in fsImpl.state.files).toBe(false);
  });

  it('endereço errado também derruba o build', () => {
    expect(() =>
      writeAuthConfig({
        env: { SUPABASE_URL: 'https://example.com', SUPABASE_PUBLISHABLE_KEY: KEY_OK },
        envFile: '.env',
        outFile: 'out.json',
        fsImpl: memoryFs(),
      }),
    ).toThrow(/SUPABASE_URL/);
  });
});
