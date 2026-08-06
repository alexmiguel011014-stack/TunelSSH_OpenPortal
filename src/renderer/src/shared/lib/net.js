export function isPrivateNetworkHost(host) {
  if (!host) return false;
  const trimmed = (host || '').trim();
  if (/^[A-Za-z]/.test(trimmed)) return true;            // hostname: aceita como privado
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);
  if (isNaN(a)) return false;
  if (a === 100) return true;                            // Tailscale CGNAT 100.64/10
  if (a === 10) return true;                             // 10/8
  if (a === 192 && b === 168) return true;               // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
  return false;
}