'use strict';

// Onde o supabase-js guarda a sessão (GOALS 20): um único arquivo cifrado com o cofre do sistema
// (Electron `safeStorage`, DPAPI no Windows). Duas regras:
//  - o arquivo nunca tem o token em texto puro; se o cofre não estiver disponível a sessão fica só
//    na memória (entra-se de novo a cada abertura) e nenhum arquivo é escrito;
//  - um arquivo ilegível ou adulterado vale como "não há sessão", nunca como erro.
// É a interface `storage` do supabase-js: getItem, setItem e removeItem.

const nodeFs = require('fs');
const path = require('path');

function createSessionStore({ file, safeStorage, fs = nodeFs, log = () => {} }) {
  const memory = new Map();
  let loaded = false;

  const canEncrypt = () => {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  };

  function load() {
    if (loaded) return;
    loaded = true;
    if (!file || !canEncrypt()) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const envelope = JSON.parse(raw);
      if (!envelope || envelope.v !== 1 || typeof envelope.enc !== 'string') {
        throw new Error('envelope inválido');
      }
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.enc, 'base64')));
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('conteúdo inválido');
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') memory.set(key, value);
      }
    } catch {
      memory.clear();
      log('sessão salva ilegível; será preciso entrar de novo');
    }
  }

  function remove() {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }

  function persist() {
    if (!file) return;
    // Sem cofre não há como proteger o arquivo: não escreve, e apaga um que tenha sobrado.
    if (!canEncrypt() || memory.size === 0) {
      remove();
      return;
    }
    try {
      const enc = safeStorage
        .encryptString(JSON.stringify(Object.fromEntries(memory)))
        .toString('base64');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ v: 1, enc }));
      fs.renameSync(temp, file);
    } catch (err) {
      log(`não consegui salvar a sessão: ${err.message}`);
    }
  }

  return {
    getItem(key) {
      load();
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      load();
      memory.set(key, String(value));
      persist();
    },
    removeItem(key) {
      load();
      memory.delete(key);
      persist();
    },
    // A sessão sobrevive a um reinício só se o cofre do sistema estiver disponível.
    isPersistent: canEncrypt,
  };
}

module.exports = { createSessionStore };
