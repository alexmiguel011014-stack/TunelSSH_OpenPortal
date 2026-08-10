// Espelha src/main/connection/net-guard.js (só Tailscale é permitido — fora
// dele o tráfego VNC/arquivos não tem criptografia própria do app). Este
// arquivo só alimenta o aviso na UI; o guard real roda no main process.
export function isPrivateNetworkHost(host) {
  if (!host) return false;
  const trimmed = (host || '').trim();
  if (/^[A-Za-z]/.test(trimmed)) return true;            // hostname: aceita (MagicDNS do Tailscale)
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  const a = parseInt(parts[0], 10);
  if (isNaN(a)) return false;
  if (a === 100) return true;                            // Tailscale CGNAT 100.64/10
  return false;
}