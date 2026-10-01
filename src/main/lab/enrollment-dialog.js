'use strict';

// Diálogo "<login> quer gerenciar este PC" (GOALS 16, G16-I5), no estilo de
// "Solicitação de conexão". Mostra o login VERIFICADO pelo tailscale whois,
// nunca um nome que o outro lado declarou. O padrão (Enter) é Rejeitar: aceitar
// dá ao gerente a tela e os arquivos deste PC sem novo pedido.

function enrollmentDialogOptions(login, signal) {
  return {
    type: 'question',
    title: 'Gerenciar este PC',
    message: `${login} quer gerenciar este PC.`,
    detail:
      'Se você aceitar, essa pessoa poderá ver o estado deste PC e abrir a tela e os arquivos dele sem pedir permissão a cada vez.\n\nVocê pode remover o gerente quando quiser, no cartão "Este PC é gerenciado" da tela inicial.\n\nAceita?',
    buttons: ['Aceitar', 'Rejeitar'],
    defaultId: 1,
    cancelId: 1,
    // Fecha a janela sozinha se quem pediu desistir ou o prazo acabar.
    signal,
  };
}

// `showDialog(options)` mostra a janela e resolve com { response } (em main.js,
// o dialog.showMessageBox do Electron sobre a janela principal).
function createEnrollmentDialog({ showDialog, drawAttention = () => () => {} }) {
  return async function askEnrollment({ login, signal }) {
    const releaseAttention = drawAttention();
    try {
      const { response } = await showDialog(enrollmentDialogOptions(login, signal));
      return !signal?.aborted && response === 0 ? 'accepted' : 'rejected';
    } catch {
      return 'rejected';
    } finally {
      releaseAttention();
    }
  };
}

module.exports = { createEnrollmentDialog, enrollmentDialogOptions };
