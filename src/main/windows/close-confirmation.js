'use strict';

// Fechar a janela encerra o app: as conexões abertas por ele caem e este PC
// deixa de aceitar pedidos de acesso. Por isso pergunta antes (decisão de
// 2026-09-30). Não pergunta quando o encerramento já foi decidido por outro
// caminho (atualização instalando, desligamento ou logoff do Windows): ali a
// pergunta travaria o encerramento.
const CLOSE_DIALOG = {
  type: 'question',
  buttons: ['Fechar', 'Cancelar'],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: 'Fechar o OpenPortal',
  message: 'Fechar o OpenPortal?',
  detail:
    'As conexões abertas neste app serão encerradas e este PC deixa de aceitar pedidos de acesso até o OpenPortal ser aberto de novo.',
};

function attachCloseConfirmation(win, { app, showMessageBox }) {
  let allowClose = false;
  let asking = false;
  const allow = () => {
    allowClose = true;
  };

  app.on('before-quit', allow);
  win.on('query-session-end', allow);
  win.on('session-end', allow);
  win.once('closed', () => app.removeListener('before-quit', allow));

  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    Promise.resolve(showMessageBox(win, CLOSE_DIALOG))
      .then(({ response }) => {
        if (response !== 0 || win.isDestroyed()) return;
        allowClose = true;
        win.close();
      })
      .catch(() => {})
      .finally(() => {
        asking = false;
      });
  });
}

module.exports = { attachCloseConfirmation, CLOSE_DIALOG };
