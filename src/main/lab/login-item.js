'use strict';

// "Iniciar com o Windows" (GOALS 16, G16-I11): o app abre sozinho quando a conta
// do dono do PC entra, para o PC de laboratório voltar a ser gerenciado depois
// de reiniciar (junto com o login automático da conta dedicada, decisão
// G16-D2). Desligado por padrão; só vale no app instalado, porque no
// desenvolvimento o item apontaria para o executável do Electron.

function createStartWithWindows({ app, isPackaged, platform = process.platform }) {
  const supported = platform === 'win32' && Boolean(isPackaged);

  function get() {
    if (!supported) return { supported: false, enabled: false };
    let enabled = false;
    try {
      enabled = Boolean(app.getLoginItemSettings().openAtLogin);
    } catch {}
    return { supported, enabled };
  }

  function set(enabled) {
    if (!supported) return { ok: false, error: 'unsupported', ...get() };
    const wanted = enabled === true;
    try {
      app.setLoginItemSettings({ openAtLogin: wanted });
    } catch {
      return { ok: false, error: 'failed', ...get() };
    }
    // Confere de verdade: o Windows pode ter recusado a gravação do item.
    const now = get();
    return now.enabled === wanted ? { ok: true, ...now } : { ok: false, error: 'failed', ...now };
  }

  return { get, set };
}

module.exports = { createStartWithWindows };
