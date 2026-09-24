'use strict';

// Log local de atividade recebida (GOALS 4): mesmo padrão de leitura/escrita
// atômica de history-manager.js, em arquivo separado — este log guarda
// eventos empurrados por OUTRAS máquinas (via reportTo), não o histórico de
// conexões que EU iniciei (isso já é history-manager.js).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ACTIVITY_DIR = app.getPath('userData');
const ACTIVITY_FILE = path.join(ACTIVITY_DIR, 'activity.json');
const MAX_ENTRIES = 200;

function readActivityLog() {
  try {
    if (fs.existsSync(ACTIVITY_FILE)) {
      let raw = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error('[activity] Error reading activity log:', err.message);
  }
  return [];
}

function writeActivityLog(entries) {
  try {
    if (!fs.existsSync(ACTIVITY_DIR)) {
      fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
    }
    const trimmed = entries.slice(-MAX_ENTRIES);
    const tmp = ACTIVITY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf-8');
    fs.renameSync(tmp, ACTIVITY_FILE);
    return true;
  } catch (err) {
    console.error('[activity] Error writing activity log:', err.message);
    return false;
  }
}

function addActivityEntry(entry) {
  const entries = readActivityLog();
  entries.push({
    id: Date.now() + '-' + Math.random().toString(16).slice(2, 6),
    ...entry,
  });
  writeActivityLog(entries);
  return true;
}

module.exports = { readActivityLog, addActivityEntry };
