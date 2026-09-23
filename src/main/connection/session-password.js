'use strict';

// Senha de acesso deste PC, estilo TeamViewer/AnyDesk: aparece na tela
// inicial e quem pede acesso com ela entra sem ninguém clicar "Aceitar".
// Muda ao abrir o app, depois de cada acesso que a usou e sob demanda. Vive
// só em memória — nunca vai para disco nem para log.
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Sem 0/O/1/I/L: dá para ditar e digitar sem ambiguidade.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

function generateSessionPassword(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// Aceita o que a pessoa digitar: minúsculas, sem hífen, com espaços.
function normalizeSessionPassword(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function sameSecret(attempt, expected) {
  const a = Buffer.from(normalizeSessionPassword(attempt));
  const b = Buffer.from(normalizeSessionPassword(expected));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Emite 'rotated' sempre que a senha muda, para a tela inicial se atualizar.
class SessionPasswordGate extends EventEmitter {
  constructor({ now = Date.now, generate = generateSessionPassword } = {}) {
    super();
    this.now = now;
    this.generate = generate;
    this.failures = new Map(); // ip -> { count, lockedUntil }
    this.current = generate();
  }

  get password() {
    return this.current;
  }

  rotate() {
    this.current = this.generate();
    this.emit('rotated');
    return this.current;
  }

  // 'ok' | 'wrong' | 'locked'. `ip` precisa ser o endereço real do socket
  // (req.remoteAddress), nunca um valor declarado no payload.
  check(ip, attempt) {
    const entry = this.failures.get(ip);
    if (entry && entry.lockedUntil > this.now()) return 'locked';
    if (sameSecret(attempt, this.current)) {
      this.failures.delete(ip);
      return 'ok';
    }
    const count = entry && !entry.lockedUntil ? entry.count + 1 : 1;
    const locked = count >= MAX_FAILURES;
    this.failures.set(ip, {
      count,
      lockedUntil: locked ? this.now() + LOCKOUT_MS : 0,
    });
    return locked ? 'locked' : 'wrong';
  }
}

module.exports = {
  SessionPasswordGate,
  generateSessionPassword,
  normalizeSessionPassword,
  MAX_FAILURES,
  LOCKOUT_MS,
};
