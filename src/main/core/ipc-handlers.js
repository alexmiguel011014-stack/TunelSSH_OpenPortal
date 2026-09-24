'use strict';

const { ipcMain, app, Notification } = require('electron');
const {
  getHostVncState,
  getVncCredential,
  readConfig,
  setHostVncLocalOnly,
  setHostVncPassword,
  setVncCredential,
  writeConfig,
} = require('../config/config-manager');
const {
  allowDirectVnc,
  applyHostVncPassword,
  decideSetupOutcome,
  generateVncPassword,
  probeVncExposure,
  relaunchTightVncTray,
  verifyVncPassword,
} = require('../system/host-vnc');
const { readHistory, addEntry } = require('../config/history-manager');
const { readActivityLog } = require('../config/activity-log');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const {
  startRdpSidecar,
  sendRdpCommand,
  stopRdpSidecar,
  SIDECAR_EXE,
} = require('../connection/rdp-sidecar');
const {
  buildConnectCommand,
  buildResizeCommand,
  buildVisibilityCommand,
  resolveRdpHostMode,
  toRendererRdpStatus,
} = require('../connection/rdp-protocol');
const {
  enableRdpHosting,
  createRdpCredential,
  generatePassword,
} = require('../system/rdp-provisioning');

const PROXY_PORT = 18900;

function send(mainWindow, channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function testTcpReachability(host, port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const HOST_VNC_ERRORS = {
  wrong:
    'O TightVNC não aceitou a senha nova. Confira se ele está instalado como serviço neste PC.',
  refused:
    'O TightVNC recusou a conexão de teste (IP bloqueado por senhas erradas?). Tente de novo em alguns minutos.',
  'no-auth': 'O TightVNC continua sem senha: a alteração não foi aplicada.',
  error: 'Não foi possível confirmar a senha nova no TightVNC (serviço parado?).',
  exposed:
    'A senha nova foi aplicada, mas o TightVNC continua aceitando conexões pela rede: a opção de só aceitar conexões locais não fez efeito. O acesso segue pelo caminho antigo.',
};

const UAC_DENIED = 'O Windows não autorizou a alteração (pedido de administrador cancelado?).';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function registerIpcHandlers(mainWindow, { accessGate } = {}) {
  const pendingRdpStarts = new Map();
  ipcMain.handle('config:get', () => {
    return readConfig();
  });

  ipcMain.handle('config:save', (_, config) => {
    return writeConfig(config);
  });

  ipcMain.handle('history:get', () => {
    return readHistory();
  });

  ipcMain.handle('history:add', (_, entry) => {
    return addEntry(entry);
  });

  ipcMain.handle('activity:get', () => {
    return readActivityLog();
  });

  ipcMain.handle('vnc:connect', (_, machine) => {
    send(mainWindow, 'vnc:status', {
      state: 'connecting',
      machineId: machine.id,
    });
    return { success: true };
  });

  ipcMain.handle('vnc:disconnect', (_, machineId) => {
    send(mainWindow, 'vnc:status', { state: 'disconnected', machineId });
    return { success: true };
  });

  ipcMain.handle('vnc:getCredential', (_, machineId) => {
    return getVncCredential(machineId);
  });

  ipcMain.handle('vnc:setCredential', (_, { machineId, password }) => {
    return { success: setVncCredential(machineId, password) };
  });

  ipcMain.handle('vnc:proxyUrl', () => {
    return `ws://127.0.0.1:${PROXY_PORT}`;
  });

  // HWND do BrowserWindow como string decimal — é isso que a sidecar C#
  // espera no argv (long.TryParse, ver sidecar/Program.cs). O buffer nativo
  // é little-endian; 8 bytes no Windows x64 (ponteiro de 64 bits), mas lemos
  // defensivamente também o caso de 4 bytes.
  function getParentHwnd() {
    const buf = mainWindow.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return String(buf.readUInt32LE(0));
    return '0';
  }

  ipcMain.handle('rdp:start', async (_, { machine, rect, lifecycleId }) => {
    pendingRdpStarts.set(machine.id, lifecycleId);
    const mode = resolveRdpHostMode(machine);
    const port = machine.rdpPort || 3389;
    const sidecarAvailable = fs.existsSync(SIDECAR_EXE);
    const tcpReachable = await testTcpReachability(machine.host, port);
    if (pendingRdpStarts.get(machine.id) !== lifecycleId) {
      return { success: false, superseded: true };
    }
    console.log(
      `[rdp-trace] ${machine.id} ${lifecycleId} preflight host=${machine.host} port=${port} mode=${mode} sidecar=${sidecarAvailable} tcp=${tcpReachable}`,
    );
    if (!sidecarAvailable || !tcpReachable) {
      send(
        mainWindow,
        'rdp:status',
        toRendererRdpStatus(
          {
            state: 'error',
            lifecycleId,
            eventName: sidecarAvailable ? 'TcpPreflightFailed' : 'SidecarMissing',
            category: sidecarAvailable ? 'network' : 'local-sidecar',
            stage: 'preflight',
            hostMode: mode,
          },
          machine.id,
        ),
      );
      if (pendingRdpStarts.get(machine.id) === lifecycleId) pendingRdpStarts.delete(machine.id);
      return { success: false };
    }
    const ok = await startRdpSidecar(
      machine.id,
      {
        parentHwnd: getParentHwnd(),
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        lifecycleId,
        mode,
      },
      (status) => send(mainWindow, 'rdp:status', toRendererRdpStatus(status, machine.id)),
    );
    if (pendingRdpStarts.get(machine.id) !== lifecycleId) {
      stopRdpSidecar(machine.id, lifecycleId, 'superseded-during-start');
      return { success: false, superseded: true };
    }
    pendingRdpStarts.delete(machine.id);
    if (ok === null) return { success: false, superseded: true };
    if (!ok) {
      return { success: false };
    }
    const commandSent = sendRdpCommand(
      machine.id,
      buildConnectCommand({
        host: machine.host,
        port,
        username: machine.rdpUsername || '',
        password: machine.rdpPassword || '',
      }),
      lifecycleId,
    );
    if (!commandSent) return { success: false };
    // A sidecar manager reporta connecting/connected/error/disconnected e
    // descarta eventos atrasados de gerações que já perderam a posse.
    return { success: true };
  });

  ipcMain.handle('rdp:resize', (_, { machineId, rect, lifecycleId }) => {
    return { success: sendRdpCommand(machineId, buildResizeCommand(rect), lifecycleId) };
  });

  ipcMain.handle('rdp:setVisible', (_, { machineId, visible, lifecycleId }) => {
    return {
      success: sendRdpCommand(machineId, buildVisibilityCommand({ visible }), lifecycleId),
    };
  });

  ipcMain.handle('rdp:stop', (_, payload) => {
    const { machineId, lifecycleId = null } =
      typeof payload === 'string' ? { machineId: payload } : payload;
    console.log(`[rdp-trace] ${machineId} ${lifecycleId || 'unowned'} ipc stop`);
    if (!lifecycleId || pendingRdpStarts.get(machineId) === lifecycleId) {
      pendingRdpStarts.delete(machineId);
    }
    const intentional = !lifecycleId;
    const stopped = stopRdpSidecar(
      machineId,
      lifecycleId,
      intentional ? 'user-stop' : 'renderer-cleanup',
    );
    if (stopped && intentional) {
      send(mainWindow, 'rdp:status', {
        state: 'disconnected',
        machineId,
        intentional: true,
        eventName: 'UserStop',
      });
    }
    return { success: stopped };
  });

  // Provisionamento (GOALS 2, "manual, one-time per machine") — cada
  // chamada abre um prompt de UAC; o usuário aprova (ou não) na hora.
  ipcMain.handle('rdp:enableHosting', async () => {
    try {
      const ok = await enableRdpHosting();
      return { success: ok };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('rdp:createCredential', async (_, { username, password }) => {
    try {
      await createRdpCredential(username, password);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('rdp:generatePassword', () => generatePassword());

  function getLocalTailscaleIp() {
    try {
      const output = execSync('tailscale ip -4', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      const ip = output.trim().split('\n')[0];
      if (ip) return ip;
    } catch {}
    try {
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && iface.address.startsWith('100.')) {
            return iface.address;
          }
        }
      }
    } catch {}
    return '';
  }

  ipcMain.handle('app:notify', (_, { title, body, silent }) => {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: title || 'OpenPortal',
          body: body || '',
          silent: !!silent,
        });
        n.show();
      }
    } catch (err) {
      console.error('Notification error:', err);
    }
  });

  ipcMain.handle('net:test', async (_, { host, port, timeoutMs }) => {
    const target = String(host || '').trim();
    if (!target) return { ok: false, error: 'Sem host' };
    const p = parseInt(port, 10) || 5900;
    const timeout = timeoutMs || 4000;
    return await new Promise((resolve) => {
      const begin = Date.now();
      const socket = net.connect({ host: target, port: p });
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ...result, host: target, port: p, ms: Date.now() - begin });
      };
      socket.setTimeout(timeout);
      socket.on('connect', () => done({ ok: true }));
      socket.on('timeout', () => done({ ok: false, error: 'Timeout' }));
      socket.on('error', (err) => done({ ok: false, error: err.code || err.message }));
    });
  });

  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  ipcMain.handle('server:localIp', () => {
    return { ip: getLocalTailscaleIp() };
  });

  // Tela inicial "Este PC": IP Tailscale + senha de acesso da sessão.
  let cachedIp = '';
  const localAccessInfo = () => {
    if (!cachedIp) cachedIp = getLocalTailscaleIp();
    const hostVnc = getHostVncState();
    return {
      ip: cachedIp,
      sessionPassword: accessGate?.password || '',
      hostVncConfigured: hostVnc.configured,
      hostVncLocalOnly: hostVnc.localOnly,
    };
  };
  accessGate?.on('rotated', () => send(mainWindow, 'access:changed', localAccessInfo()));
  ipcMain.handle('access:getLocal', () => localAccessInfo());
  ipcMain.handle('access:rotate', () => {
    accessGate?.rotate();
    return localAccessInfo();
  });

  // Gera uma senha forte para o TightVNC deste PC e o deixa aceitando só
  // conexões locais (GOALS 10), com UAC. Confere de verdade antes de guardar:
  // a senha vale em 127.0.0.1 (por onde o túnel entrega o VNC) e a 5900 não
  // atende mais pelo IP Tailscale deste PC.
  ipcMain.handle('hostVnc:setup', async () => {
    const password = generateVncPassword();
    try {
      await applyHostVncPassword(password);
    } catch {
      return { success: false, error: UAC_DENIED };
    }
    relaunchTightVncTray().catch(() => {});
    let verdict = 'error';
    for (let attempt = 0; attempt < 5 && verdict === 'error'; attempt++) {
      if (attempt > 0) await sleep(1500);
      verdict = await verifyVncPassword('127.0.0.1', 5900, password);
    }
    const { ip } = localAccessInfo();
    const exposure = verdict === 'ok' && ip ? await probeVncExposure(ip, 5900) : 'closed';
    const outcome = decideSetupOutcome({ verdict, exposure });
    if (outcome.store) setHostVncPassword(password, { localOnly: outcome.localOnly });
    if (outcome.error) {
      console.error(`[hostVnc] Configuração do TightVNC incompleta: ${outcome.error}`);
      const error = HOST_VNC_ERRORS[outcome.error] || HOST_VNC_ERRORS.error;
      return { success: false, error, ...localAccessInfo() };
    }
    console.log('[hostVnc] TightVNC deste PC: senha nova confirmada e só conexões locais');
    return { success: true, ...localAccessInfo() };
  });

  // Caminho de volta: aceitar de novo VNC direto da rede. Sem só-local este PC
  // deixa de oferecer o túnel e quem conectar volta ao caminho antigo (5900).
  ipcMain.handle('hostVnc:allowDirect', async () => {
    try {
      await allowDirectVnc();
    } catch {
      return { success: false, error: UAC_DENIED };
    }
    relaunchTightVncTray().catch(() => {});
    const { ip } = localAccessInfo();
    let exposure = 'closed';
    for (let attempt = 0; attempt < 5 && exposure !== 'open' && ip; attempt++) {
      if (attempt > 0) await sleep(1500);
      exposure = await probeVncExposure(ip, 5900);
    }
    setHostVncLocalOnly(exposure !== 'open');
    console.log(`[hostVnc] VNC direto liberado: 5900 pela rede ${exposure}`);
    return exposure === 'open'
      ? { success: true, ...localAccessInfo() }
      : {
          success: false,
          error: 'O TightVNC continua aceitando só conexões locais.',
          ...localAccessInfo(),
        };
  });
}

module.exports = { registerIpcHandlers };
