'use strict';

// Os erros do Supabase (e de rede) em frases para a pessoa, em português. Nenhuma mensagem diz se um
// e-mail tem conta: "e-mail ou senha incorretos" vale para os dois casos.

const NETWORK_PATTERN =
  /fetch failed|failed to fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out/i;

const MESSAGES = {
  invalid_credentials: 'E-mail ou senha incorretos.',
  email_not_confirmed: 'Seu e-mail ainda não foi confirmado.',
  user_already_exists:
    'Não foi possível criar a conta com esses dados. Se você já tem conta, use Entrar.',
  email_exists: 'Não foi possível criar a conta com esses dados. Se você já tem conta, use Entrar.',
  weak_password: 'Senha fraca. Use pelo menos 8 caracteres, com letras e números.',
  same_password: 'A nova senha precisa ser diferente da atual.',
  otp_expired: 'Código inválido ou vencido. Confira os 6 dígitos ou peça outro.',
  over_email_send_rate_limit: 'Muitos e-mails enviados. Aguarde alguns minutos e tente de novo.',
  over_request_rate_limit: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  email_address_invalid: 'Confira o e-mail digitado.',
  validation_failed: 'Confira os dados digitados.',
  signup_disabled: 'Novos cadastros estão desligados no momento.',
  network: 'Sem conexão com o servidor de contas. Verifique a internet e tente de novo.',
  'session-expired': 'Sua sessão expirou. Entre de novo.',
  'not-teacher': 'Só professores aprovados podem fazer isso.',
  'already-decided': 'Esse pedido já foi decidido.',
  'no-profile': 'Esta conta não tem perfil. Fale com um professor.',
  unconfigured: 'Contas indisponíveis nesta versão do aplicativo.',
  'bad-request': 'Confira os dados digitados.',
  unknown: 'Não foi possível concluir. Tente de novo em instantes.',
};

const SESSION_CODES = new Set([
  'session_expired',
  'session_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'bad_jwt',
  'user_not_found',
]);

function isNetworkError(error) {
  if (!error) return false;
  if (error.code === 'network' || error.code === 'timeout') return true;
  if (error.name === 'AuthRetryableFetchError') return true;
  const text = `${error.name || ''} ${error.message || ''} ${error.details || ''}`;
  return NETWORK_PATTERN.test(text);
}

// Código estável + frase. `code` é o do Supabase quando há um conhecido.
function describeAuthError(error) {
  if (isNetworkError(error)) return { code: 'network', message: MESSAGES.network };
  const raw = error?.code || '';
  if (SESSION_CODES.has(raw))
    return { code: 'session-expired', message: MESSAGES['session-expired'] };
  // As funções approve_teacher/refuse_teacher (db): 42501 = não é professor; P0002 = sem pedido.
  if (raw === '42501') return { code: 'not-teacher', message: MESSAGES['not-teacher'] };
  if (raw === 'P0002') return { code: 'already-decided', message: MESSAGES['already-decided'] };
  if (MESSAGES[raw]) return { code: raw, message: MESSAGES[raw] };
  return { code: 'unknown', message: MESSAGES.unknown };
}

module.exports = { MESSAGES, describeAuthError, isNetworkError };
