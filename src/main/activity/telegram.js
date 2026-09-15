'use strict';

// Alerta opcional via Telegram para o mesmo evento de atividade que já
// alimenta o push in-app (ver main.js, reportSessionActivity). Desligado por
// padrão — só dispara quando o usuário habilita e configura token/chatId em
// Configurações. `telegraf` só é exigido dentro de sendTelegramAlert, para
// que o resto do app funcione normalmente mesmo sem a dependência instalada
// (rode `npm install telegraf` antes de habilitar de verdade — ver
// docs/TELEGRAM_SETUP.md).

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round((ms || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}min ${sec}s` : `${sec}s`;
}

function formatTime(ts) {
  if (!ts) return '?';
  return new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatActivityMessage(event) {
  const { identity, machineName, startedAt, endedAt, durationMs, filesTransferred } = event || {};
  return (
    `${identity} conectou-se a ${machineName} das ${formatTime(startedAt)} às ` +
    `${formatTime(endedAt)} (${formatDuration(durationMs)}). ` +
    `Arquivos transferidos: ${filesTransferred || 0}.`
  );
}

// Nunca lança: falha de envio (token inválido, rede fora, dependência não
// instalada) só é logada — jamais deve afetar a sessão remota real nem o log
// in-app, que já são a fonte de verdade independentemente disso.
async function sendTelegramAlert(telegramConfig, event, deps = {}) {
  const { token, chatId } = telegramConfig || {};
  if (!token || !chatId) return;
  try {
    const Telegraf = deps.Telegraf || require('telegraf').Telegraf;
    const bot = new Telegraf(token);
    await bot.telegram.sendMessage(chatId, formatActivityMessage(event));
  } catch (err) {
    console.error(
      "[telegram] Failed to send alert (telegraf instalado? 'npm install telegraf'):",
      err.message,
    );
  }
}

module.exports = {
  formatActivityMessage,
  formatDuration,
  formatTime,
  sendTelegramAlert,
};
