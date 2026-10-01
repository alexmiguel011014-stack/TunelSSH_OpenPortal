'use strict';

// Controle do serviço do laboratório visto do app (GOALS 17): onde está o
// executável que veio no app, ligar e desligar o modo laboratório (com UAC), ler o
// estado e entregar ao `lab-status` o que o serviço sabe (estado do PC, aluno,
// disco). As peças do sistema entram por `deps`, para o teste não precisar de
// PowerShell, UAC nem do serviço.

const fs = require('fs');
const path = require('path');

const SERVICE_EXE = 'OpenPortalLabService.exe';
const READY_TIMEOUT_MS = 20_000;
const HOST_STATUS_TTL_MS = 30_000;

// No app instalado o executável vem do extraResources (package.json) em
// resources/lab-service; no desenvolvimento, é o build do MSBuild dentro do projeto.
function resolveServiceExe({
  moduleDir = __dirname,
  resourcesPath = process.resourcesPath,
  exists = fs.existsSync,
} = {}) {
  if (moduleDir.split(/[\\/]/).includes('app.asar')) {
    return path.join(resourcesPath, 'lab-service', SERVICE_EXE);
  }
  const root = path.join(moduleDir, '..', '..', '..', 'lab-service', 'bin');
  const release = path.join(root, 'Release', SERVICE_EXE);
  const debug = path.join(root, 'Debug', SERVICE_EXE);
  return exists(release) || !exists(debug) ? release : debug;
}

// Do estado do serviço para os estados que `lab-status` conhece.
function mapServiceState(state) {
  if (state === 'reserved') return 'reserved';
  if (state === 'in-use' || state === 'ending') return 'in-use';
  return 'free';
}

function createServiceControl({
  client,
  provisioning,
  serviceSource,
  exists = fs.existsSync,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  let installedCache = { at: -Infinity, value: 'missing' };

  async function installedStatus() {
    if (now() - installedCache.at > HOST_STATUS_TTL_MS) {
      installedCache = {
        at: now(),
        value: await provisioning.readServiceStatus(),
      };
    }
    return installedCache.value;
  }

  // Estado completo, para a tela de Configurações.
  async function getState() {
    const [raw, rdpHosting] = await Promise.all([
      provisioning.readServiceStatus(),
      provisioning.verifyRdpHostingEnabled().catch(() => false),
    ]);
    installedCache = { at: now(), value: raw };
    const state = {
      installed: raw !== 'missing',
      running: raw === 'Running',
      // O Remote Desktop do Windows (porta 3389 e regra de firewall) por onde o aluno entra.
      rdpHosting: rdpHosting === true,
      binaryAvailable: exists(serviceSource),
      reachable: false,
    };
    if (state.running) {
      const status = await client.status({ timeoutMs: 3000 });
      if (status.ok) {
        state.reachable = true;
        state.quota = status.quota;
        state.studentCount = status.studentCount;
        state.pcState = status.state;
        if (status.reservation) state.reservation = status.reservation;
      } else {
        state.error = status.error;
      }
    }
    return state;
  }

  async function waitUntilReady() {
    const deadline = now() + READY_TIMEOUT_MS;
    let state = await getState();
    while (!(state.running && state.reachable) && now() < deadline) {
      await sleep(1000);
      state = await getState();
    }
    return state;
  }

  async function enable({ studentsOnSite = false } = {}) {
    if (!exists(serviceSource)) {
      return {
        ok: false,
        error: 'missing-binary',
        message: 'O serviço do laboratório não veio neste app (versão sem GOALS 17?)',
      };
    }
    const ownerSid = await provisioning.readOwnerSid();
    if (!ownerSid) {
      return {
        ok: false,
        error: 'no-owner',
        message: 'Não consegui descobrir a conta que roda o app',
      };
    }
    let script;
    try {
      script = provisioning.buildEnableLabScript({
        serviceSource,
        ownerSid,
        studentsOnSite: studentsOnSite === true,
      });
    } catch (err) {
      return { ok: false, error: 'bad-request', message: err.message };
    }
    log('habilitando o modo laboratório (UAC)');
    try {
      await provisioning.runElevatedPowerShell(script);
    } catch {
      return {
        ok: false,
        error: 'elevation',
        message: 'O Windows não autorizou a alteração (pedido de administrador cancelado?)',
      };
    }
    // Lê de volta em vez de confiar só no código de saída do UAC.
    const state = await waitUntilReady();
    if (state.running && state.reachable) return { ok: true, state };
    return {
      ok: false,
      error: 'not-ready',
      message:
        'O serviço foi instalado, mas não respondeu. Veja C:\\ProgramData\\OpenPortal\\lab\\service.log',
      state,
    };
  }

  async function disable() {
    const state = await getState();
    if (state.reachable && state.pcState && state.pcState !== 'free') {
      return {
        ok: false,
        error: 'busy',
        message: 'Há uma reserva em andamento; encerre-a antes de desabilitar o modo laboratório',
      };
    }
    log('desabilitando o modo laboratório (UAC)');
    try {
      await provisioning.runElevatedPowerShell(provisioning.buildDisableLabScript());
    } catch {
      return {
        ok: false,
        error: 'elevation',
        message: 'O Windows não autorizou a alteração (pedido de administrador cancelado?)',
      };
    }
    const after = await getState();
    if (!after.installed) return { ok: true, state: after };
    return {
      ok: false,
      error: 'not-removed',
      message: 'O serviço continua instalado',
      state: after,
    };
  }

  // O que o `lab-status` pede ao serviço, a cada consulta do gerente. Sem o pipe
  // (serviço parado ou não instalado), só diz se está instalado; a consulta ao
  // PowerShell é guardada por 30 s.
  async function hostStatusInput() {
    const status = await client.status({ timeoutMs: 2500 });
    if (status.ok) {
      const input = {
        service: { installed: true, running: true },
        state: mapServiceState(status.state),
        studentCount: status.studentCount,
      };
      if (Number.isSafeInteger(status.lastSeq)) input.lastSeq = status.lastSeq;
      const reservation = status.reservation;
      if (reservation && input.state !== 'free') {
        input.student = {
          label: reservation.label,
          since: reservation.firstLogonAt || reservation.createdAt || 0,
          endsAt: reservation.endsAt,
        };
      }
      if (status.disk)
        input.disk = {
          totalGb: status.disk.totalGb,
          freeGb: status.disk.freeGb,
        };
      return input;
    }
    const raw = await installedStatus();
    return {
      service: { installed: raw !== 'missing', running: raw === 'Running' },
    };
  }

  return { disable, enable, getState, hostStatusInput };
}

module.exports = {
  SERVICE_EXE,
  createServiceControl,
  mapServiceState,
  resolveServiceExe,
};
