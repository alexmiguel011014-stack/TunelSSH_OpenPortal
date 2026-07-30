const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      let raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return JSON.parse(raw);
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
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_FILE);
    return true;
  } catch (err) {
    console.error('[config] Error writing config:', err.message);
    return false;
  }
}

module.exports = { readConfig, writeConfig, DEFAULT_CONFIG };
