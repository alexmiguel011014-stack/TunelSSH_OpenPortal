'use strict';

// IPC dos programas necessários (GOALS 22): `prereqs:get` lê o estado, `prereqs:install` instala o
// Tailscale ou o TightVNC com o mesmo script do instalador (resources/prereqs/install-prereq.ps1) e
// `prereqs:openTailscale` abre a janela do Tailscale para a pessoa entrar na conta.
const nodeFs = require('fs');
const nodeOs = require('os');
const nodePath = require('path');
const { spawn: nodeSpawn } = require('child_process');
const { detectPrerequisites, TAILSCALE_GUI } = require('./prerequisites');
const { psQuote, runElevatedPowerShell } = require('./rdp-provisioning');

// O nome vai para um script que roda como administrador: só estes dois valem.
const INSTALLABLE = new Set(['tailscale', 'tightvnc']);
const UAC_DENIED = 'O Windows não recebeu a permissão de administrador.';

// -File com -ExecutionPolicy Bypass: um script em arquivo não roda com a política padrão do Windows
// cliente. `exit $LASTEXITCODE` mantém o código do script, que o Start-Process -Verb RunAs perde.
function buildInstallCommand({ scriptPath, name, resultFile }) {
  return [
    `& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${psQuote(scriptPath)}' -Name ${name} -ResultFile '${psQuote(resultFile)}'`,
    'exit $LASTEXITCODE',
  ].join('; ');
}

function readResult(fs, file) {
  try {
    const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
    return {
      ok: parsed.ok === true,
      restartNeeded: parsed.restartNeeded === true,
      message: typeof parsed.message === 'string' ? parsed.message : '',
    };
  } catch {
    return null;
  }
}

function registerPrerequisitesIpc({
  ipcMain,
  scriptPath,
  detect = detectPrerequisites,
  runElevated = runElevatedPowerShell,
  spawn = nodeSpawn,
  fs = nodeFs,
  os = nodeOs,
  path = nodePath,
  guiPath = TAILSCALE_GUI,
}) {
  let installing = false;

  ipcMain.handle('prereqs:get', () => detect());

  ipcMain.handle('prereqs:install', async (_event, name) => {
    if (typeof name !== 'string' || !INSTALLABLE.has(name)) {
      return { success: false, error: 'Programa não reconhecido.' };
    }
    if (installing) {
      return { success: false, error: 'Já há uma instalação em andamento.' };
    }
    installing = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openportal-prereq-'));
    const resultFile = path.join(dir, 'result.json');
    try {
      try {
        await runElevated(buildInstallCommand({ scriptPath, name, resultFile }));
      } catch {
        return { success: false, error: UAC_DENIED, prerequisites: await detect() };
      }
      const result = readResult(fs, resultFile);
      const prerequisites = await detect();
      if (!result) {
        return {
          success: false,
          error: 'A instalação não terminou: o script não deixou resultado.',
          prerequisites,
        };
      }
      return {
        success: result.ok,
        restartNeeded: result.restartNeeded,
        ...(result.ok ? { message: result.message } : { error: result.message }),
        prerequisites,
      };
    } finally {
      installing = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  ipcMain.handle('prereqs:openTailscale', () => {
    if (!fs.existsSync(guiPath)) {
      return { success: false, error: 'O Tailscale não foi encontrado neste PC.' };
    }
    try {
      spawn(guiPath, [], { detached: true, stdio: 'ignore' }).unref();
      return { success: true };
    } catch (err) {
      return { success: false, error: `Não foi possível abrir o Tailscale: ${err.message}` };
    }
  });
}

module.exports = { INSTALLABLE, UAC_DENIED, buildInstallCommand, registerPrerequisitesIpc };
