#!/usr/bin/env node
const { startFileServer } = require('./file-server');

const PORT = parseInt(process.argv[2] || '5001', 10);
const ROOT_DIR = process.argv[3] || process.env.USERPROFILE || process.env.HOME || '.';

startFileServer(PORT, ROOT_DIR).then(({ port, rootDir }) => {
  console.log(`[remote-file-server] Listening on port ${port}`);
  console.log(`[remote-file-server] Root directory: ${rootDir}`);
}).catch((err) => {
  console.error(`[remote-file-server] Failed to start: ${err.message}`);
  process.exit(1);
});
