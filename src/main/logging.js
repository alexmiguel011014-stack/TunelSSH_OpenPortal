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

// Rotaciona também com o app aberto, não só ao iniciar: um app que ficou
// dias no ar (ou num laço de erro) chegou a 6,5 GB no PC B. Escrita síncrona
// num descritor aberto: sem corrida entre o buffer e o rename da rotação.
function createRotatingLog(filePath, maxBytes = MAX_LOG_BYTES) {
  let fd = null;
  let size = 0;
  const open = () => {
    try {
      fd = fs.openSync(filePath, 'a');
      size = fs.fstatSync(fd).size;
    } catch {
      fd = null;
      size = 0;
    }
  };
  rotateIfNeeded(filePath);
  open();
  return {
    write(text) {
      if (fd === null) return;
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > maxBytes) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.rmSync(filePath + '.1', { force: true });
          fs.renameSync(filePath, filePath + '.1');
        } catch {}
        open();
        if (fd === null) return;
      }
      try {
        fs.writeSync(fd, text);
        size += bytes;
      } catch {}
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
        fd = null;
      }
      return Promise.resolve();
    },
  };
}

function writeLog(stream, prefix, args) {
  const msg = args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack;
      return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
    })
    .join(' ');
  const formatted = `[${new Date().toISOString()}] ${prefix}: ${msg}\n`;
  // Em app empacotado no Windows não há console anexado: escrever em
  // process.stdout pode lançar EPIPE/EBADF e derrubar o processo.
  try {
    stream.write(formatted);
  } catch {}
  try {
    process.stdout.write(formatted);
  } catch {}
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

  const outStream = createRotatingLog(outLogPath);
  const errStream = createRotatingLog(errLogPath);

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

module.exports = { initLogging, createRotatingLog };
