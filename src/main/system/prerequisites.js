'use strict';

// Detecta os programas de que o OpenPortal depende neste PC (GOALS 22): o Tailscale (rede e
// identidade de quem conecta), o TightVNC 2 (servidor VNC deste PC) e a edição do Windows (só
// Pro, Enterprise e Education recebem conexões RDP). Nada aqui lança: o que não deu para ler
// vira 'unknown', e quem decide bloqueio trata 'unknown' como "deixa passar".
const nodeExecFile = require('child_process').execFile;
const nodeFs = require('fs');
const { readPowerShell } = require('./rdp-provisioning');

// O instalador do Tailscale nem sempre põe a CLI no PATH (mesmo caminho de connection/identity.js).
const TAILSCALE_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const TAILSCALE_GUI = 'C:\\Program Files\\Tailscale\\tailscale-ipn.exe';

// 'running' (conectado) | 'needs-login' | 'stopped' (instalado, não está ligado) | 'missing'
function parseTailscaleState(status) {
  const backend = status && status.BackendState;
  if (backend === 'Running') return 'running';
  if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth') return 'needs-login';
  return 'stopped';
}

// 'ok' com o JSON, 'notfound' (não existe esse executável) ou 'error' (rodou e falhou, ou travou).
function runTailscaleStatus(execFile, binary) {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        ['status', '--json'],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve({ kind: err.code === 'ENOENT' ? 'notfound' : 'error' });
          try {
            resolve({ kind: 'ok', json: JSON.parse(stdout) });
          } catch {
            resolve({ kind: 'error' });
          }
        },
      );
    } catch {
      resolve({ kind: 'error' });
    }
  });
}

async function detectTailscale(deps = {}) {
  const execFile = deps.execFile || nodeExecFile;
  const existsSync = deps.existsSync || nodeFs.existsSync;
  const candidates = ['tailscale'];
  if (existsSync(TAILSCALE_CLI)) candidates.push(TAILSCALE_CLI);

  let ranAndFailed = false;
  for (const binary of candidates) {
    const result = await runTailscaleStatus(execFile, binary);
    if (result.kind === 'ok') return { state: parseTailscaleState(result.json) };
    if (result.kind === 'error') ranAndFailed = true;
  }
  // Achou o executável mas ele não respondeu: o serviço está parado.
  const installed = ranAndFailed || existsSync(TAILSCALE_CLI);
  return { state: installed ? 'stopped' : 'missing' };
}

// Uma consulta só ao PowerShell: serviço do TightVNC 2 (tvnserver), versão do TightVNC na lista de
// programas instalados (ele conta mesmo sem o serviço, para reconhecer um TightVNC 4) e a edição.
const HOST_PROBE_COMMAND = [
  '$svc = Get-Service -Name tvnserver -ErrorAction SilentlyContinue',
  "$paths = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
  "$app = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'TightVNC*' } | Select-Object -First 1",
  "$edition = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue).EditionID",
  "'svc=' + $(if ($svc) { [string]$svc.Status } else { '' }) + '|ver=' + $(if ($app) { [string]$app.DisplayVersion } else { '' }) + '|edition=' + [string]$edition",
].join('; ');

// "svc=Running|ver=2.8.90.0|edition=Professional" -> { service, version, edition }
function parseHostProbe(output) {
  const fields = {};
  for (const part of String(output || '')
    .trim()
    .split('|')) {
    const at = part.indexOf('=');
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1).trim();
  }
  const service = /^running$/i.test(fields.svc)
    ? 'running'
    : /^(stopped|paused|stoppending|startpending)/i.test(fields.svc)
      ? 'stopped'
      : '';
  return { service, version: fields.ver || '', edition: fields.edition || '' };
}

// Só o TightVNC 2 (GPL) é o que o app sabe configurar (host-vnc.js). A 4.0 guarda a configuração
// em outro lugar: aparece como 'unsupported'. Sem o serviço (só o visualizador) é como se faltasse.
function tightVncStateFrom({ service, version }) {
  const major = parseInt(String(version).split('.')[0], 10);
  if (Number.isFinite(major) && major >= 3) return { state: 'unsupported', version };
  if (service) return { state: service, version };
  return { state: 'missing', version };
}

// Home (Core, CoreN, CoreSingleLanguage...) só conecta; Pro, Enterprise e Education também recebem.
function rdpHostingFor(edition) {
  if (!edition) return null;
  return !/^Core/i.test(edition);
}

async function detectHost(deps = {}) {
  const output = await (deps.readPowerShell || readPowerShell)(HOST_PROBE_COMMAND, deps);
  const probe = parseHostProbe(output);
  return {
    tightvnc: tightVncStateFrom(probe),
    windows: { edition: probe.edition, rdpHosting: rdpHostingFor(probe.edition) },
  };
}

const UNKNOWN = {
  tailscale: { state: 'unknown' },
  tightvnc: { state: 'unknown', version: '' },
  windows: { edition: '', rdpHosting: null },
};

// Nunca lança; uma leitura que falha vira 'unknown'.
async function detectPrerequisites(deps = {}) {
  const [tailscale, host] = await Promise.all([
    detectTailscale(deps).catch(() => UNKNOWN.tailscale),
    detectHost(deps).catch(() => ({ tightvnc: UNKNOWN.tightvnc, windows: UNKNOWN.windows })),
  ]);
  return { tailscale, ...host, checkedAt: Date.now() };
}

module.exports = {
  HOST_PROBE_COMMAND,
  TAILSCALE_CLI,
  TAILSCALE_GUI,
  detectHost,
  detectPrerequisites,
  detectTailscale,
  parseHostProbe,
  parseTailscaleState,
  rdpHostingFor,
  tightVncStateFrom,
};
