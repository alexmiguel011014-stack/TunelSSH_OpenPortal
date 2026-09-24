'use strict';

// Gerencia o processo sidecar nativo por máquina RDP conectada (mesmo
// padrão de Map-por-id de file-transfer-session.js) — GOALS 1 já permite
// várias conexões simultâneas, então várias sidecars podem coexistir, uma
// por máquina em modo RDP. Ver sidecar/Program.cs para o outro lado do pipe.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { encodeCommand, parseStatusMessage } = require('./rdp-protocol');

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

const CONTROL_READY_TIMEOUT_MS = 5_000;
const COMMAND_DISPATCH_TIMEOUT_MS = 5_000;
const CONNECT_CALL_TIMEOUT_MS = 10_000;
const FIRST_EVENT_TIMEOUT_MS = 15_000;
const AUTHENTICATION_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 750;

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

// Sobe uma sidecar embutida ou em janela nativa. Substitui qualquer sidecar
// já rodando para essa mesma máquina.
function createRdpSidecarManager({
  spawnProcess = spawn,
  connectPipe = connectPipeWithRetry,
  randomUUID = crypto.randomUUID,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sidecarExe = SIDECAR_EXE,
  ownerPid = process.pid,
  controlReadyTimeoutMs = CONTROL_READY_TIMEOUT_MS,
  commandDispatchTimeoutMs = COMMAND_DISPATCH_TIMEOUT_MS,
  connectCallTimeoutMs = CONNECT_CALL_TIMEOUT_MS,
  firstEventTimeoutMs = FIRST_EVENT_TIMEOUT_MS,
  authenticationTimeoutMs = AUTHENTICATION_TIMEOUT_MS,
  stopGraceMs = STOP_GRACE_MS,
} = {}) {
  const sidecars = new Map(); // machineId -> { process, pipeClient, lifecycleId, ... }

  function clearEntryTimers(entry) {
    if (entry.readyTimer) clearTimer(entry.readyTimer);
    if (entry.firstEventTimer) clearTimer(entry.firstEventTimer);
    if (entry.commandDispatchTimer) clearTimer(entry.commandDispatchTimer);
    if (entry.connectCallTimer) clearTimer(entry.connectCallTimer);
    if (entry.authenticationTimer) clearTimer(entry.authenticationTimer);
    if (entry.stopTimer) clearTimer(entry.stopTimer);
    entry.readyTimer = null;
    entry.firstEventTimer = null;
    entry.commandDispatchTimer = null;
    entry.connectCallTimer = null;
    entry.authenticationTimer = null;
    entry.stopTimer = null;
  }

  function clearConnectionTimers(entry) {
    if (entry.commandDispatchTimer) clearTimer(entry.commandDispatchTimer);
    if (entry.connectCallTimer) clearTimer(entry.connectCallTimer);
    if (entry.firstEventTimer) clearTimer(entry.firstEventTimer);
    if (entry.authenticationTimer) clearTimer(entry.authenticationTimer);
    entry.commandDispatchTimer = null;
    entry.connectCallTimer = null;
    entry.firstEventTimer = null;
    entry.authenticationTimer = null;
  }

  function emitStatus(machineId, entry, status) {
    if (sidecars.get(machineId) !== entry || entry.plannedStop) return false;

    const terminalFailure = status.state === 'error' || status.state === 'disconnected';
    if (terminalFailure && entry.terminalFailure) return false;
    if (status.state === entry.lastState && status.eventName === entry.lastEventName) return false;

    if (status.state === 'connected') {
      entry.connected = true;
      clearConnectionTimers(entry);
      entry.connectCommand = null;
    } else if (terminalFailure) {
      entry.terminalFailure = true;
      clearConnectionTimers(entry);
      entry.connectCommand = null;
    }

    entry.lastState = status.state;
    entry.lastEventName = status.eventName;
    entry.onStatus?.({ ...status, lifecycleId: entry.lifecycleId });
    return true;
  }

  function failEntry(machineId, entry, category, eventName, reasonCode) {
    return emitStatus(machineId, entry, {
      state: 'error',
      category,
      eventName,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  }

  function settleReady(entry, value) {
    if (!entry.resolveReady) return;
    const resolve = entry.resolveReady;
    entry.resolveReady = null;
    resolve(value);
  }

  function scheduleAuthenticationDeadline(machineId, entry) {
    if (entry.authenticationTimer) clearTimer(entry.authenticationTimer);
    entry.authenticationTimer = setTimer(() => {
      if (sidecars.get(machineId) !== entry || entry.connected || entry.terminalFailure) return;
      console.error(
        `[rdp-trace] ${machineId} ${entry.lifecycleId} authentication timeout after ${authenticationTimeoutMs}ms`,
      );
      failEntry(machineId, entry, 'timeout', 'AuthenticationTimeout');
      stopRdpSidecar(machineId, entry.lifecycleId, 'authentication-timeout');
    }, authenticationTimeoutMs);
  }

  function scheduleCommandDispatchDeadline(machineId, entry) {
    if (entry.commandDispatchTimer) clearTimer(entry.commandDispatchTimer);
    entry.commandDispatchTimer = setTimer(() => {
      if (sidecars.get(machineId) !== entry || entry.terminalFailure) return;
      failEntry(machineId, entry, 'local-sidecar', 'CommandDispatchTimeout');
      stopRdpSidecar(machineId, entry.lifecycleId, 'command-dispatch-timeout');
    }, commandDispatchTimeoutMs);
  }

  function scheduleConnectCallDeadline(machineId, entry) {
    if (entry.connectCallTimer) clearTimer(entry.connectCallTimer);
    entry.connectCallTimer = setTimer(() => {
      if (sidecars.get(machineId) !== entry || entry.terminalFailure) return;
      failEntry(machineId, entry, 'timeout', 'ConnectCallTimeout');
      stopRdpSidecar(machineId, entry.lifecycleId, 'connect-call-timeout');
    }, connectCallTimeoutMs);
  }

  function scheduleFirstEventDeadline(machineId, entry) {
    if (entry.firstEventTimer) clearTimer(entry.firstEventTimer);
    entry.firstEventTimer = setTimer(async () => {
      if (sidecars.get(machineId) !== entry || entry.connected || entry.terminalFailure) return;
      console.error(
        `[rdp-trace] ${machineId} ${entry.lifecycleId} first-event timeout after ${firstEventTimeoutMs}ms mode=${entry.hostMode}`,
      );
      if (
        entry.requestedMode === 'auto-fallback' &&
        entry.hostMode === 'embedded' &&
        !entry.fallbackAttempted &&
        entry.connectReturned &&
        entry.connectCommand
      ) {
        const command = entry.connectCommand;
        const options = {
          ...entry.startOptions,
          hostMode: 'native-window',
          fallbackAttempted: true,
        };
        const onStatus = entry.onStatus;
        emitStatus(machineId, entry, {
          state: 'connecting',
          category: 'host-control',
          eventName: 'NativeFallbackStarting',
          stage: 'starting',
          hostMode: 'native-window',
        });
        const started = await startRdpSidecar(machineId, options, onStatus);
        if (started) sendRdpCommand(machineId, command, entry.lifecycleId);
        return;
      }
      failEntry(machineId, entry, 'timeout', 'FirstEventTimeout');
      stopRdpSidecar(machineId, entry.lifecycleId, 'first-event-timeout');
    }, firstEventTimeoutMs);
  }

  function handleNativeStatus(machineId, entry, status) {
    if (status.lifecycleId && status.lifecycleId !== entry.lifecycleId) return;
    if (status.eventName === 'DisconnectComplete' && entry.plannedStop) {
      entry.pipeClient?.end();
      return;
    }
    const normalized = { ...status };
    if (status.state === 'ready') {
      entry.nativeReady = true;
      if (entry.readyTimer) clearTimer(entry.readyTimer);
      entry.readyTimer = null;
      settleReady(entry, true);
      return;
    }
    if ((status.state === 'error' || status.state === 'disconnected') && !entry.nativeReady) {
      settleReady(entry, false);
    }
    if (status.eventName === 'CommandReceived') {
      if (entry.commandDispatchTimer) clearTimer(entry.commandDispatchTimer);
      entry.commandDispatchTimer = null;
      scheduleConnectCallDeadline(machineId, entry);
      if (entry.requestedMode !== 'auto-fallback') entry.connectCommand = null;
    } else if (status.eventName === 'ConnectInvoking') {
      if (entry.commandDispatchTimer) clearTimer(entry.commandDispatchTimer);
      entry.commandDispatchTimer = null;
      scheduleConnectCallDeadline(machineId, entry);
    } else if (status.eventName === 'ConnectReturned') {
      if (entry.connectCallTimer) clearTimer(entry.connectCallTimer);
      entry.connectCallTimer = null;
      entry.connectReturned = true;
      if (!entry.firstNativeEventSeen && !entry.connected && !entry.terminalFailure) {
        scheduleFirstEventDeadline(machineId, entry);
      }
    } else if (status.eventName === 'OnConnecting' || status.eventName === 'OnConnected') {
      entry.firstNativeEventSeen = true;
      if (entry.connectCallTimer) clearTimer(entry.connectCallTimer);
      entry.connectCallTimer = null;
      if (entry.firstEventTimer) clearTimer(entry.firstEventTimer);
      entry.firstEventTimer = null;
      scheduleAuthenticationDeadline(machineId, entry);
    } else if (status.eventName === 'OnAuthenticationWarningDisplayed') {
      entry.firstNativeEventSeen = true;
      clearConnectionTimers(entry);
    } else if (status.eventName === 'OnAuthenticationWarningDismissed') {
      scheduleAuthenticationDeadline(machineId, entry);
    }
    if (status.eventName === 'OnNetworkStatusChanged') return;
    if (status.eventName === 'OnLogonError') normalized.category = 'authentication';
    else if (status.eventName === 'OnFatalError') normalized.category = 'host-control';
    else if (status.eventName === 'OnDisconnected') {
      normalized.category = entry.connected ? 'remote-disconnect' : 'session';
      if (!entry.connected) normalized.state = 'error';
    }
    emitStatus(machineId, entry, normalized);
  }

  async function startRdpSidecar(
    machineId,
    {
      parentHwnd,
      x,
      y,
      w,
      h,
      lifecycleId = 'legacy',
      mode = 'embedded',
      hostMode = mode === 'native-window' ? 'native-window' : 'embedded',
      fallbackAttempted = false,
    },
    onStatus,
  ) {
    stopRdpSidecar(machineId, null, 'superseded-by-start');

    // Nome "nu" do pipe: NamedPipeServerStream (lado C#, ver sidecar/Program.cs)
    // só quer o nome, sem o prefixo \\.\pipe\ — quem adiciona esse prefixo é
    // o cliente (Node), ao montar o caminho pra net.createConnection.
    const pipeBaseName = `OpenPortalRdpSidecar-${randomUUID()}`;
    const pipePath = `\\\\.\\pipe\\${pipeBaseName}`;
    const proc = spawnProcess(sidecarExe, [
      pipeBaseName,
      hostMode === 'native-window' ? '0' : String(parentHwnd),
      String(x),
      String(y),
      String(w),
      String(h),
      hostMode,
      lifecycleId,
      String(ownerPid),
    ]);
    let resolveReady;
    const readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const entry = {
      process: proc,
      pipeClient: null,
      lifecycleId,
      requestedMode: mode,
      hostMode,
      fallbackAttempted,
      startOptions: { parentHwnd, x, y, w, h, lifecycleId, mode },
      onStatus,
      plannedStop: null,
      terminalFailure: false,
      connected: false,
      nativeReady: false,
      connectCommand: null,
      readyPromise,
      resolveReady,
      readyTimer: null,
      firstEventTimer: null,
      commandDispatchTimer: null,
      connectCallTimer: null,
      authenticationTimer: null,
      stopTimer: null,
      lastState: null,
      lastEventName: null,
      connectReturned: false,
      firstNativeEventSeen: false,
    };
    sidecars.set(machineId, entry);
    console.log(`[rdp-trace] ${machineId} ${lifecycleId} spawned pid=${proc.pid} mode=${hostMode}`);

    proc.on('error', (err) => {
      console.error(`[rdp-sidecar] ${machineId} spawn error:`, err.message);
      settleReady(entry, false);
      failEntry(machineId, entry, 'local-sidecar', 'ProcessError');
    });
    proc.on('exit', (code, signal) => {
      console.log(
        `[rdp-trace] ${machineId} ${lifecycleId} child exit code=${code} signal=${signal || 'none'} planned=${entry.plannedStop || 'no'}`,
      );
      clearEntryTimers(entry);
      settleReady(entry, false);
      if (!entry.plannedStop) {
        failEntry(machineId, entry, 'local-sidecar', 'ProcessExit', code ?? signal ?? undefined);
      }
      if (sidecars.get(machineId) === entry) sidecars.delete(machineId);
    });

    const pipeClient = await connectPipe(pipePath);
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
      settleReady(entry, false);
      failEntry(machineId, entry, 'local-sidecar', 'PipeConnectFailed');
      stopRdpSidecar(machineId, lifecycleId, 'pipe-connect-failed');
      return false;
    }
    entry.pipeClient = pipeClient;
    console.log(`[rdp-trace] ${machineId} ${lifecycleId} pipe connected`);
    let pending = '';
    pipeClient.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const status = parseStatusMessage(trimmed);
        if (status) {
          console.log(`[rdp-trace] ${machineId} ${lifecycleId} native ${JSON.stringify(status)}`);
          handleNativeStatus(machineId, entry, status);
        }
      }
    });
    pipeClient.on('end', () => {
      console.log(`[rdp-trace] ${machineId} ${lifecycleId} pipe end`);
      settleReady(entry, false);
      failEntry(machineId, entry, 'local-sidecar', 'PipeEnd');
    });
    pipeClient.on('close', (hadError) => {
      console.log(`[rdp-trace] ${machineId} ${lifecycleId} pipe close error=${hadError}`);
      settleReady(entry, false);
      failEntry(machineId, entry, 'local-sidecar', 'PipeClose');
    });
    pipeClient.on('error', (err) => {
      console.error(
        `[rdp-trace] ${machineId} ${lifecycleId} pipe error=${err.code || err.message}`,
      );
      settleReady(entry, false);
      failEntry(machineId, entry, 'local-sidecar', 'PipeError', err.code);
    });
    entry.readyTimer = setTimer(() => {
      if (sidecars.get(machineId) !== entry || entry.nativeReady) return;
      failEntry(machineId, entry, 'timeout', 'ControlReadyTimeout');
      settleReady(entry, false);
      stopRdpSidecar(machineId, lifecycleId, 'control-ready-timeout');
    }, controlReadyTimeoutMs);
    if (entry.nativeReady) {
      clearTimer(entry.readyTimer);
      entry.readyTimer = null;
    }
    const ready = await entry.readyPromise;
    return ready;
  }

  function ownsEntry(entry, requestedLifecycleId) {
    return !requestedLifecycleId || entry.lifecycleId === requestedLifecycleId;
  }

  function sendRdpCommand(machineId, command, requestedLifecycleId = null) {
    const entry = sidecars.get(machineId);
    if (!entry || !entry.pipeClient || !ownsEntry(entry, requestedLifecycleId)) return false;
    if (!entry.nativeReady) return false;
    try {
      const ownedCommand = { ...command, lifecycleId: entry.lifecycleId };
      entry.pipeClient.write(encodeCommand(ownedCommand), (err) => {
        if (err) failEntry(machineId, entry, 'local-sidecar', 'CommandWriteFailed', err.code);
      });
      console.log(`[rdp-trace] ${machineId} ${entry.lifecycleId} command=${command.cmd} sent`);
      if (command.cmd === 'connect') {
        entry.connectCommand = command;
        entry.connectReturned = false;
        entry.firstNativeEventSeen = false;
        emitStatus(machineId, entry, {
          state: 'connecting',
          stage: 'command-written',
          eventName: 'CommandSent',
          hostMode: entry.hostMode,
        });
        scheduleCommandDispatchDeadline(machineId, entry);
      }
      return true;
    } catch (err) {
      failEntry(machineId, entry, 'local-sidecar', 'CommandWriteFailed', err.code);
      return false;
    }
  }

  function stopRdpSidecar(machineId, requestedLifecycleId = null, reason = 'requested') {
    const entry = sidecars.get(machineId);
    if (!entry) return false;
    if (!ownsEntry(entry, requestedLifecycleId)) {
      console.log(
        `[rdp-trace] ${machineId} ${requestedLifecycleId} ignored stop owner=${entry.lifecycleId}`,
      );
      return false;
    }
    entry.plannedStop = reason;
    clearEntryTimers(entry);
    settleReady(entry, false);
    entry.connectCommand = null;
    console.log(
      `[rdp-trace] ${machineId} ${requestedLifecycleId || 'unowned'} stop reason=${reason} owner=${entry.lifecycleId}`,
    );
    try {
      if (entry.pipeClient) {
        entry.pipeClient.write(
          encodeCommand({ cmd: 'disconnect', lifecycleId: entry.lifecycleId }),
          (err) => {
            if (err) entry.pipeClient?.end();
          },
        );
      }
    } catch {}
    if (sidecars.get(machineId) === entry) sidecars.delete(machineId);
    if (entry.pipeClient) {
      entry.stopTimer = setTimer(() => {
        try {
          entry.pipeClient.end();
        } catch {}
        try {
          entry.process.kill();
        } catch {}
      }, stopGraceMs);
    } else {
      try {
        entry.process.kill();
      } catch {}
    }
    return true;
  }

  function isRdpSidecarRunning(machineId) {
    return sidecars.has(machineId);
  }

  return { startRdpSidecar, sendRdpCommand, stopRdpSidecar, isRdpSidecarRunning };
}

const defaultManager = createRdpSidecarManager();

module.exports = {
  ...defaultManager,
  createRdpSidecarManager,
  SIDECAR_EXE,
  CONTROL_READY_TIMEOUT_MS,
  COMMAND_DISPATCH_TIMEOUT_MS,
  CONNECT_CALL_TIMEOUT_MS,
  FIRST_EVENT_TIMEOUT_MS,
  AUTHENTICATION_TIMEOUT_MS,
};
