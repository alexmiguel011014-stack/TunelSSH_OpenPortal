'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) {
      fs.rmSync(filePath + '.1', { force: true });
      fs.renameSync(filePath, filePath + '.1');
    }
  } catch {}
}

function writeLog(stream, prefix, args) {
  const msg = args.map(arg => {
    if (arg instanceof Error) return arg.stack;
    return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
  }).join(' ');
  const formatted = `[${new Date().toISOString()}] ${prefix}: ${msg}\n`;
  // Em app empacotado no Windows não há console anexado: escrever em
  // process.stdout pode lançar EPIPE/EBADF e derrubar o processo.
  try { stream.write(formatted); } catch {}
  try { process.stdout.write(formatted); } catch {}
}

// Configuração de logs em arquivo (diretório oficial de dados do usuário,
// pois __dirname falha quando empacotado dentro do arquivo .asar).
function initLogging() {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const outLogPath = path.join(logsDir, 'electron-out.log');
  const errLogPath = path.join(logsDir, 'electron-err.log');

  rotateIfNeeded(outLogPath);
  rotateIfNeeded(errLogPath);

  const outStream = fs.createWriteStream(outLogPath, { flags: 'a' });
  const errStream = fs.createWriteStream(errLogPath, { flags: 'a' });
  outStream.on('error', () => {});
  errStream.on('error', () => {});

  console.log = (...args) => writeLog(outStream, 'INFO', args);
  console.error = (...args) => writeLog(errStream, 'ERROR', args);

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  console.log('[main] Log files:', outLogPath);
  console.error('[main] Log files:', errLogPath);
}

module.exports = { initLogging };
