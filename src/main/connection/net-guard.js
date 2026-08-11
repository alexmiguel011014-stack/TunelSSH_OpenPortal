'use strict';

// Compartilhado entre proxy.js (VNC) e file-transfer-session.js (arquivos): só
// permite discar hosts da rede Tailscale, nunca IP público nem LAN pura.
// Restrito a 100.x de propósito: fora do túnel Tailscale (WireGuard,
// criptografado) o protocolo VNC e o de arquivos trafegam em texto puro —
// LAN local (10.x/192.168.x/172.16-31.x) exporia senha e tela a qualquer
// um na mesma rede.
const isDev = process.env.NODE_ENV === 'development';

function isAllowedHost(host) {
  if (!host) return false;
  if (isDev && (host === '127.0.0.1' || host === 'localhost')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const a = parseInt(parts[0], 10);
  if (a === 100) return true;                                    // Tailscale (CGNAT 100.64/10)
  return false;
}

module.exports = { isAllowedHost };
