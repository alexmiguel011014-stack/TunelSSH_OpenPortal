const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const CONFIG_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  machines: [
    { id: 'pc-1', name: 'PC 1', host: '', port: 5900 },
    { id: 'pc-2', name: 'PC 2', host: '', port: 5900 },
    { id: 'pc-3', name: 'PC 3', host: '', port: 5900 },
  ],
  proxyPort: 18900,
  // Tailscale login emails auto-approved on THIS machine (who may connect to
  // me), independent of `machines` above (who I connect out to). See
  // identity.js.
  allowedUsers: [],
  // GOALS 4: Tailscale login emails THIS machine pushes its own session
  // activity to (e.g. the professor's identity, for a classroom machine).
  // Independent of allowedUsers — a machine can auto-approve someone without
  // reporting to them, and vice versa.
  reportTo: [],
  // GOALS 4: optional Telegram alert layered on top of the reportTo push,
  // off by default. token is encrypted at rest the same way machine
  // passwords are — see encryptSecret/decryptSecret below.
  telegram: { enabled: false, token: '', chatId: '' },
};

// Segredos (senha VNC, token do Telegram) nunca são gravados em texto puro
// no disco — usa o cofre do SO (DPAPI no Windows via Electron safeStorage).
// Chamado só dentro de readConfig/writeConfig, que só rodam via IPC após
// app.whenReady().
function encryptSecret(plain) {
  if (!plain) return undefined;
  if (!safeStorage.isEncryptionAvailable()) return { plain };
  return { enc: safeStorage.encryptString(plain).toString('base64') };
}

function decryptSecret(field) {
  if (!field) return '';
  if (field.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(field.enc, 'base64'));
    } catch {
      return '';
    }
  }
  return field.plain || '';
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      let raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const config = JSON.parse(raw);
      if (Array.isArray(config.machines)) {
        config.machines = config.machines.map((m) => {
          if (!m.passwordEnc) return m;
          const { passwordEnc, ...rest } = m;
          return { ...rest, password: decryptSecret(passwordEnc) };
        });
      }
      if (config.telegram?.tokenEnc) {
        const { tokenEnc, ...rest } = config.telegram;
        config.telegram = { ...rest, token: decryptSecret(tokenEnc) };
      }
      return config;
    }
  } catch (err) {
    console.error('[config] Error reading config:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function writeConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    // Merge onto the existing on-disk config rather than replacing it
    // outright: callers like App.jsx's saveMachines() only ever send
    // { machines }, and a plain overwrite would silently drop unrelated
    // top-level fields (allowedUsers, reportTo, telegram) not part of this
    // particular save.
    const toWrite = { ...readConfig(), ...config };
    if (Array.isArray(toWrite.machines)) {
      toWrite.machines = toWrite.machines.map((m) => {
        if (!m.password) return m;
        const { password, ...rest } = m;
        return { ...rest, passwordEnc: encryptSecret(password) };
      });
    }
    if (toWrite.telegram && toWrite.telegram.token) {
      const { token, ...rest } = toWrite.telegram;
      toWrite.telegram = { ...rest, tokenEnc: encryptSecret(token) };
    }
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_FILE);
    return true;
  } catch (err) {
    console.error('[config] Error writing config:', err.message);
    return false;
  }
}

module.exports = { readConfig, writeConfig, DEFAULT_CONFIG };
