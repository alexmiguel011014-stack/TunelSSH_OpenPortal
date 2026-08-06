#!/usr/bin/env node
// Agente autônomo (sem Electron): expõe a pasta do usuário na porta 5001.
// Uso: node remote-file-server.js [porta] [raiz]
const os = require('os');
const { startFileServer, PROTOCOL_VERSION } = require('./file-server');

const PORT = parseInt(process.argv[2] || '5001', 10);
// os.homedir() cobre Windows, Linux e macOS sem depender de variável de ambiente.
const ROOT_DIR = process.argv[3] || os.homedir() || process.cwd();

startFileServer(PORT, ROOT_DIR).then(({ port, rootDir }) => {
  console.log(`[remote-file-server] Ouvindo na porta ${port} (protocolo v${PROTOCOL_VERSION}, ${process.platform})`);
  console.log(`[remote-file-server] Raiz: ${rootDir}`);
}).catch((err) => {
  console.error(`[remote-file-server] Falha ao iniciar: ${err.message}`);
  process.exit(1);
});
