'use strict';

// Roda antes do `vite build` (npm run build): escreve src/main/auth/auth-config.json com o endereço
// do projeto Supabase e a chave pública deste build (GOALS 20). Sem as variáveis o arquivo não é
// criado (e um antigo é apagado): o build sai sem contas e o app segue funcionando como antes.
// Valores presentes mas errados — a chave SECRETA, por exemplo — derrubam o build, em vez de
// publicar um instalador com a chave errada.

const fs = require('fs');
const path = require('path');
const {
  GENERATED_FILE,
  describeReason,
  parseEnvFile,
  validateConfig,
} = require('../src/main/auth/config');

function resolveConfig({ env, envFileText }) {
  const fromFile = parseEnvFile(envFileText);
  return validateConfig({
    url: env.SUPABASE_URL || fromFile.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || fromFile.SUPABASE_PUBLISHABLE_KEY,
  });
}

// Devolve { action: 'written' | 'skipped', ... } ou lança com o motivo quando os valores existem e estão errados.
function writeAuthConfig({
  env = process.env,
  envFile,
  outFile = GENERATED_FILE,
  fsImpl = fs,
} = {}) {
  let envFileText = '';
  try {
    envFileText = fsImpl.readFileSync(envFile, 'utf8');
  } catch {}

  const checked = resolveConfig({ env, envFileText });
  if (!checked.ok) {
    fsImpl.rmSync(outFile, { force: true });
    if (checked.reason === 'missing') {
      return { action: 'skipped', reason: checked.reason };
    }
    throw new Error(`Configuração do Supabase inválida: ${describeReason(checked.reason)}`);
  }
  fsImpl.writeFileSync(
    outFile,
    `${JSON.stringify({ url: checked.url, publishableKey: checked.publishableKey }, null, 2)}\n`,
  );
  return { action: 'written', url: checked.url };
}

module.exports = { writeAuthConfig };

if (require.main === module) {
  try {
    const result = writeAuthConfig({ envFile: path.join(__dirname, '..', '.env') });
    console.log(
      result.action === 'written'
        ? `[auth-config] contas ligadas neste build (${result.url})`
        : '[auth-config] SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY ausentes: build sem contas',
    );
  } catch (err) {
    console.error(`[auth-config] ${err.message}`);
    process.exit(1);
  }
}
