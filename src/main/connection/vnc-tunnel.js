'use strict';

// Tokens do túnel VNC (GOALS 10): cada aprovação gera um, preso ao IP real de
// quem pediu e à sessão aprovada. Só com ele o host encaminha a conexão pela
// porta 18902 até o TightVNC local — que deixa de aceitar conexões da rede —,
// então a senha do TightVNC vista numa sessão antiga não abre nada sozinha.
// Vivem só em memória e nunca vão para log.
const crypto = require('crypto');
const { FailureLimiter } = require('./session-password');

const MAX_TOKEN_AGE_MS = 12 * 60 * 60 * 1000;

class VncTunnelTokens {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.tokens = new Map(); // token -> { ip, issuedAt }
    this.limiter = new FailureLimiter({ now });
  }

  issue(ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(token, { ip, issuedAt: this.now() });
    return token;
  }

  revoke(token) {
    if (token) this.tokens.delete(token);
  }

  // 'ok' | 'wrong' | 'locked'. `ip` precisa ser o endereço real do socket.
  check(token, ip) {
    if (this.limiter.isLocked(ip)) return 'locked';
    const match = this.find(token);
    if (match && match.entry.ip === ip) {
      if (this.now() - match.entry.issuedAt <= MAX_TOKEN_AGE_MS) {
        this.limiter.reset(ip);
        return 'ok';
      }
      this.tokens.delete(match.token);
    }
    return this.limiter.fail(ip);
  }

  // Compara com todos os tokens vivos em tempo constante (são poucos).
  find(token) {
    const probe = Buffer.from(String(token || ''));
    let match = null;
    for (const [known, entry] of this.tokens) {
      const candidate = Buffer.from(known);
      if (candidate.length === probe.length && crypto.timingSafeEqual(candidate, probe)) {
        match = { token: known, entry };
      }
    }
    return match;
  }
}

module.exports = { VncTunnelTokens, MAX_TOKEN_AGE_MS };
