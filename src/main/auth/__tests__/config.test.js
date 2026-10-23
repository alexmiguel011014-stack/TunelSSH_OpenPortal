import { describe, expect, it } from 'vitest';
import { loadAuthConfig, parseEnvFile, validateConfig } from '../config.js';

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv';

// Uma chave antiga (JWT) com o papel indicado no corpo; a assinatura não é conferida pelo app.
const jwt = (role) =>
  [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url'),
    'assinatura',
  ].join('.');

const files = (map) => (file) => {
  if (file in map) return map[file];
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

describe('parseEnvFile', () => {
  it('lê KEY=valor, ignora comentários e tira aspas', () => {
    expect(
      parseEnvFile(
        [
          '# comentário',
          'SUPABASE_URL=https://x.supabase.co',
          'export A="com espaço"',
          "B='aspas simples'",
          'C=valor # comentário no fim',
          'linha sem igual',
          '',
        ].join('\r\n'),
      ),
    ).toEqual({
      SUPABASE_URL: 'https://x.supabase.co',
      A: 'com espaço',
      B: 'aspas simples',
      C: 'valor',
    });
  });
});

describe('validateConfig', () => {
  it('aceita o endereço do projeto e a chave publishable', () => {
    expect(validateConfig({ url: `${URL_OK}/`, publishableKey: ` ${KEY_OK} ` })).toEqual({
      ok: true,
      url: URL_OK,
      publishableKey: KEY_OK,
    });
  });

  it('aceita a chave antiga "anon" (JWT)', () => {
    expect(validateConfig({ url: URL_OK, publishableKey: jwt('anon') }).ok).toBe(true);
  });

  it('recusa a chave SECRETA, nova ou antiga', () => {
    expect(
      validateConfig({ url: URL_OK, publishableKey: 'sb_secret_abcdefghijklmnopqrstuv' }),
    ).toEqual({
      ok: false,
      reason: 'secret-key',
    });
    expect(validateConfig({ url: URL_OK, publishableKey: jwt('service_role') })).toEqual({
      ok: false,
      reason: 'secret-key',
    });
  });

  it('recusa endereço que não é de um projeto Supabase (http, outro domínio, caminho)', () => {
    for (const url of [
      'http://abc.supabase.co',
      'https://abc.example.com',
      'https://evil.com/.supabase.co',
      'https://abc.supabase.co/rest/v1',
      'https://supabase.co',
    ]) {
      expect(validateConfig({ url, publishableKey: KEY_OK }), url).toEqual({
        ok: false,
        reason: 'invalid-url',
      });
    }
  });

  it('recusa chave que não parece uma chave do Supabase, e valores ausentes', () => {
    expect(validateConfig({ url: URL_OK, publishableKey: 'qualquer-coisa' }).reason).toBe(
      'invalid-key',
    );
    expect(validateConfig({ url: URL_OK, publishableKey: 'sb_publishable_curta' }).reason).toBe(
      'invalid-key',
    );
    expect(validateConfig({ url: URL_OK, publishableKey: jwt('authenticated') }).reason).toBe(
      'invalid-key',
    );
    expect(validateConfig({ url: URL_OK }).reason).toBe('missing');
    expect(validateConfig({}).reason).toBe('missing');
    expect(validateConfig().reason).toBe('missing');
  });
});

describe('loadAuthConfig', () => {
  const generated = JSON.stringify({ url: URL_OK, publishableKey: KEY_OK });

  it('usa o arquivo gerado no build', () => {
    const result = loadAuthConfig({
      isDev: false,
      generatedFile: 'gen.json',
      readFile: files({ 'gen.json': generated }),
    });
    expect(result).toEqual({
      configured: true,
      url: URL_OK,
      publishableKey: KEY_OK,
      source: 'build',
    });
  });

  it('em desenvolvimento usa o ambiente e, na falta dele, o .env', () => {
    const readFile = files({
      '.env': `SUPABASE_URL=${URL_OK}\nSUPABASE_PUBLISHABLE_KEY=${KEY_OK}\n`,
    });
    expect(
      loadAuthConfig({ isDev: true, env: {}, envFile: '.env', generatedFile: 'x', readFile }),
    ).toMatchObject({
      configured: true,
      source: 'env',
      url: URL_OK,
    });

    const other = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
    expect(
      loadAuthConfig({
        isDev: true,
        env: { SUPABASE_URL: other, SUPABASE_PUBLISHABLE_KEY: KEY_OK },
        envFile: '.env',
        generatedFile: 'x',
        readFile,
      }).url,
    ).toBe(other);
  });

  it('o app instalado ignora variáveis de ambiente e .env', () => {
    const result = loadAuthConfig({
      isDev: false,
      env: { SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: KEY_OK },
      envFile: '.env',
      generatedFile: 'x',
      readFile: files({ '.env': `SUPABASE_URL=${URL_OK}\nSUPABASE_PUBLISHABLE_KEY=${KEY_OK}` }),
    });
    expect(result).toEqual({ configured: false, reason: 'missing' });
  });

  it('sem nada configurado, ou com arquivo gerado estragado, fica desligado', () => {
    expect(
      loadAuthConfig({
        isDev: true,
        env: {},
        envFile: '.env',
        generatedFile: 'x',
        readFile: files({}),
      }),
    ).toEqual({
      configured: false,
      reason: 'missing',
    });
    expect(
      loadAuthConfig({
        isDev: false,
        generatedFile: 'gen.json',
        readFile: files({ 'gen.json': '{não é json' }),
      }).configured,
    ).toBe(false);
    expect(
      loadAuthConfig({
        isDev: false,
        generatedFile: 'gen.json',
        readFile: files({
          'gen.json': JSON.stringify({
            url: URL_OK,
            publishableKey: 'sb_secret_abcdefghijklmnopqrstuv',
          }),
        }),
      }),
    ).toEqual({ configured: false, reason: 'secret-key' });
  });
});
