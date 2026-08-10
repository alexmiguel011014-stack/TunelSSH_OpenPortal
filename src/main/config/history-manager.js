const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const HISTORY_DIR = app.getPath('userData');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const MAX_ENTRIES = 200;

function readHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      let raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error('[history] Error reading history:', err.message);
  }
  return [];
}

function writeHistory(entries) {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
    const trimmed = entries.slice(-MAX_ENTRIES);
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf-8');
    fs.renameSync(tmp, HISTORY_FILE);
    return true;
  } catch (err) {
    console.error('[history] Error writing history:', err.message);
    return false;
  }
}

function addEntry(entry) {
  const entries = readHistory();
  entries.push(entry);
  writeHistory(entries);
  return true;
}

module.exports = { readHistory, addEntry };
