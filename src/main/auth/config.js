'use strict';

// De onde o app tira o endereço do projeto Supabase e a chave pública (GOALS 20).
//
// - Build instalado: o arquivo `auth-config.json`, gerado na hora do `npm run build` a partir das
//   variáveis SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY (scripts/write-auth-config.js). Variáveis do
//   ambiente do usuário não valem aqui: o app instalado só fala com o projeto com que foi gerado.
// - Desenvolvimento: as mesmas variáveis, do ambiente ou do `.env` da raiz (gitignored).
//
// A chave pública (`sb_publishable_...`) foi feita para ir dentro do app: quem manda é a segurança
// por linha do banco. A chave secreta NUNCA entra aqui, e esta validação recusa uma que apareça.

const fs = require('fs');
const path = require('path');

const GENERATED_FILE = path.join(__dirname, 'auth-config.json');
const URL_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/;

// `KEY=valor` por linha; `#` comenta; aspas simples ou duplas em volta do valor são tiradas.
function parseEnvFile(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[match[1]] = value;
  }
  return values;
}

function decodeJwtRole(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    return JSON.parse(json).role;
  } catch {
    return undefined;
  }
}

// Confere o par antes de aceitá-lo. Devolve { ok: true, url, publishableKey } ou { ok: false, reason }
// com `reason` em: missing, invalid-url, secret-key, invalid-key.
function validateConfig({ url, publishableKey } = {}) {
  const rawUrl = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  const key = typeof publishableKey === 'string' ? publishableKey.trim() : '';
  if (!rawUrl && !key) return { ok: false, reason: 'missing' };
  if (!URL_PATTERN.test(rawUrl)) return { ok: false, reason: 'invalid-url' };
  if (!key) return { ok: false, reason: 'missing' };
  if (key.startsWith('sb_secret_')) return { ok: false, reason: 'secret-key' };
  if (key.startsWith('sb_publishable_')) {
    return key.length >= 24
      ? { ok: true, url: rawUrl, publishableKey: key }
      : { ok: false, reason: 'invalid-key' };
  }
  // Chave antiga (JWT): só a "anon" serve; a "service_role" dá acesso total ao banco.
  if (key.split('.').length === 3) {
    const role = decodeJwtRole(key);
    if (role === 'service_role') return { ok: false, reason: 'secret-key' };
    if (role === 'anon') return { ok: true, url: rawUrl, publishableKey: key };
  }
  return { ok: false, reason: 'invalid-key' };
}

const REASON_TEXT = {
  missing: 'SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY não foram informados neste build',
  'invalid-url': 'SUPABASE_URL deve ser https://<projeto>.supabase.co',
  'secret-key':
    'a chave informada é a chave SECRETA do Supabase; use a chave pública (publishable)',
  'invalid-key': 'SUPABASE_PUBLISHABLE_KEY não parece uma chave pública do Supabase',
};

function describeReason(reason) {
  return REASON_TEXT[reason] || REASON_TEXT.missing;
}

function readIfExists(readFile, file) {
  try {
    return readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// Devolve { configured: true, url, publishableKey, source } ou { configured: false, reason }.
function loadAuthConfig({
  isDev = process.env.NODE_ENV === 'development',
  env = process.env,
  envFile = path.join(__dirname, '..', '..', '..', '.env'),
  generatedFile = GENERATED_FILE,
  readFile = fs.readFileSync,
} = {}) {
  const generated = readIfExists(readFile, generatedFile);
  if (generated) {
    let parsed = null;
    try {
      parsed = JSON.parse(generated);
    } catch {}
    const checked = validateConfig(parsed || {});
    return checked.ok
      ? {
          configured: true,
          url: checked.url,
          publishableKey: checked.publishableKey,
          source: 'build',
        }
      : { configured: false, reason: checked.reason };
  }
  if (!isDev) return { configured: false, reason: 'missing' };

  const fromFile = parseEnvFile(readIfExists(readFile, envFile));
  const checked = validateConfig({
    url: env.SUPABASE_URL || fromFile.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || fromFile.SUPABASE_PUBLISHABLE_KEY,
  });
  return checked.ok
    ? { configured: true, url: checked.url, publishableKey: checked.publishableKey, source: 'env' }
    : { configured: false, reason: checked.reason };
}

module.exports = {
  GENERATED_FILE,
  describeReason,
  loadAuthConfig,
  parseEnvFile,
  validateConfig,
};
