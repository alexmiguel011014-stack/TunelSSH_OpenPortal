'use strict';

// Gerencia o processo sidecar nativo por máquina RDP conectada (mesmo
// padrão de Map-por-id de file-transfer-session.js) — GOALS 1 já permite
// várias conexões simultâneas, então várias sidecars podem coexistir, uma
// por máquina em modo RDP. Ver sidecar/Program.cs para o outro lado do pipe.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { encodeCommand } = require('./rdp-protocol');

const SIDECAR_EXE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'sidecar',
  'bin',
  'Debug',
  'OpenPortalRdpSidecar.exe',
);

const sidecars = new Map(); // machineId -> { process, pipeClient }

function connectPipeOnce(pipePath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

// A sidecar só cria o pipe depois de subir a janela — tenta de novo em vez
// de assumir que já está pronta assim que o processo é criado.
async function connectPipeWithRetry(pipePath, attempts = 30, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await connectPipeOnce(pipePath);
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

// Sobe uma sidecar reparented dentro de parentHwnd, na posição/tamanho
// dados (coordenadas relativas à área do BrowserWindow — ver
// docs/ARQUITETURA_CONEXAO.md). Substitui qualquer sidecar já rodando para
// essa mesma máquina.
async function startRdpSidecar(machineId, { parentHwnd, x, y, w, h }) {
  stopRdpSidecar(machineId);

  // Nome "nu" do pipe: NamedPipeServerStream (lado C#, ver sidecar/Program.cs)
  // só quer o nome, sem o prefixo \\.\pipe\ — quem adiciona esse prefixo é
  // o cliente (Node), ao montar o caminho pra net.createConnection.
  const pipeBaseName = `OpenPortalRdpSidecar-${crypto.randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeBaseName}`;
  const proc = spawn(SIDECAR_EXE, [
    pipeBaseName,
    String(parentHwnd),
    String(x),
    String(y),
    String(w),
    String(h),
  ]);
  const entry = { process: proc, pipeClient: null };
  sidecars.set(machineId, entry);

  proc.on('error', (err) => console.error(`[rdp-sidecar] ${machineId} spawn error:`, err.message));
  proc.on('exit', (code) => {
    console.log(`[rdp-sidecar] ${machineId} exited with code ${code}`);
    if (sidecars.get(machineId) === entry) sidecars.delete(machineId);
  });

  const pipeClient = await connectPipeWithRetry(pipePath);
  // Outra inicialização pode ter substituído esta enquanto aguardávamos o
  // pipe (por exemplo, o segundo ciclo do React StrictMode no modo dev).
  // Não deixe a tentativa antiga publicar erro sobre a nova conexão.
  if (sidecars.get(machineId) !== entry) {
    try {
      pipeClient?.end();
    } catch {}
    return null;
  }
  if (!pipeClient) {
    console.error(`[rdp-sidecar] ${machineId} failed to connect to sidecar pipe`);
    return false;
  }
  entry.pipeClient = pipeClient;
  return true;
}

function sendRdpCommand(machineId, command) {
  const entry = sidecars.get(machineId);
  if (!entry || !entry.pipeClient) return false;
  entry.pipeClient.write(encodeCommand(command));
  return true;
}

function stopRdpSidecar(machineId) {
  const entry = sidecars.get(machineId);
  if (!entry) return;
  try {
    entry.pipeClient?.end();
  } catch {}
  try {
    entry.process.kill();
  } catch {}
  sidecars.delete(machineId);
}

function isRdpSidecarRunning(machineId) {
  return sidecars.has(machineId);
}

module.exports = {
  startRdpSidecar,
  sendRdpCommand,
  stopRdpSidecar,
  isRdpSidecarRunning,
  SIDECAR_EXE,
};
