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
};

// Senha VNC nunca é gravada em texto puro no disco — usa o cofre do SO
// (DPAPI no Windows via Electron safeStorage). Chamado só dentro de
// readConfig/writeConfig, que só rodam via IPC após app.whenReady().
function encryptPassword(plain) {
  if (!plain) return undefined;
  if (!safeStorage.isEncryptionAvailable()) return { plain };
  return { enc: safeStorage.encryptString(plain).toString('base64') };
}

function decryptPassword(field) {
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
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const config = JSON.parse(raw);
      if (Array.isArray(config.machines)) {
        config.machines = config.machines.map((m) => {
          if (!m.passwordEnc) return m;
          const { passwordEnc, ...rest } = m;
          return { ...rest, password: decryptPassword(passwordEnc) };
        });
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
    const toWrite = { ...config };
    if (Array.isArray(toWrite.machines)) {
      toWrite.machines = toWrite.machines.map((m) => {
        if (!m.password) return m;
        const { password, ...rest } = m;
        return { ...rest, passwordEnc: encryptPassword(password) };
      });
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
