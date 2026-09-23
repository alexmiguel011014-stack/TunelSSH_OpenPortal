const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { mergeStoredMachine, toRendererMachine } = require('./machine-credentials');

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

function readStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      let raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[config] Error reading config:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function writeStoredConfig(config) {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_FILE);
}

function readConfig() {
  const config = readStoredConfig();
  if (Array.isArray(config.machines)) {
    config.machines = config.machines.map((machine) => {
      let out = toRendererMachine(machine);
      if (out.rdpPasswordEnc) {
        const { rdpPasswordEnc, ...rest } = out;
        out = { ...rest, rdpPassword: decryptSecret(rdpPasswordEnc) };
      }
      return out;
    });
  }
  if (config.telegram?.tokenEnc) {
    const { tokenEnc, ...rest } = config.telegram;
    config.telegram = { ...rest, token: decryptSecret(tokenEnc) };
  }
  return config;
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
    const existing = readStoredConfig();
    const toWrite = { ...existing, ...config };
    if (Array.isArray(config.machines)) {
      const existingById = new Map(
        (existing.machines || []).map((machine) => [machine.id, machine]),
      );
      toWrite.machines = config.machines.map((machine) => {
        let out = mergeStoredMachine(existingById.get(machine.id), machine, encryptSecret);
        if (Object.prototype.hasOwnProperty.call(machine, 'rdpPassword')) {
          const { rdpPassword, ...rest } = out;
          delete rest.rdpPasswordEnc;
          out = { ...rest };
          if (rdpPassword) out.rdpPasswordEnc = encryptSecret(rdpPassword);
        }
        return out;
      });
    }
    if (config.telegram && Object.prototype.hasOwnProperty.call(config.telegram, 'token')) {
      const { token, ...rest } = { ...(existing.telegram || {}), ...config.telegram };
      toWrite.telegram = { ...rest };
      if (token) toWrite.telegram.tokenEnc = encryptSecret(token);
    }
    writeStoredConfig(toWrite);
    return true;
  } catch (err) {
    console.error('[config] Error writing config:', err.message);
    return false;
  }
}

function getVncCredential(machineId) {
  const machine = (readStoredConfig().machines || []).find((entry) => entry.id === machineId);
  return decryptSecret(machine?.passwordEnc);
}

function setVncCredential(machineId, password) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const config = readStoredConfig();
    const index = (config.machines || []).findIndex((machine) => machine.id === machineId);
    if (index < 0) return false;
    config.machines[index] = mergeStoredMachine(
      config.machines[index],
      { id: machineId, password: String(password || '') },
      encryptSecret,
    );
    writeStoredConfig(config);
    return true;
  } catch (err) {
    console.error('[config] Error saving VNC credential:', err.message);
    return false;
  }
}

module.exports = { getVncCredential, readConfig, setVncCredential, writeConfig, DEFAULT_CONFIG };
