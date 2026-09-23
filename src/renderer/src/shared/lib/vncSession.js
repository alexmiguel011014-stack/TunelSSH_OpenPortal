export function normalizeQuickVncHost(value) {
  const host = String(value || '').trim();
  if (!host) return { host: '', error: 'Digite o IP Tailscale do PC remoto' };
  if (host.includes(':')) return { host: '', error: 'Use apenas o IP, sem porta' };
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return { host: '', error: 'Use o formato 100.x.x.x, sem porta nem espaços' };
  }
  const octets = host.split('.').map(Number);
  if (octets.some((part) => part > 255)) {
    return { host: '', error: 'Use um endereço IPv4 válido' };
  }
  return { host, error: '' };
}

export function buildVncViewerUrl({ host, port = 5900, proxyUrl, attemptId }) {
  const params = new URLSearchParams({
    host: String(host),
    port: String(port),
    proxy: String(proxyUrl),
    attempt: String(attemptId),
  });
  return `./noVNC/vnc.html?${params}`;
}

export function isRetryableVncState(state) {
  return state === 'connection-lost';
}

export function shouldUseSavedVncCredential({ hasSavedCredential, savedCredentialTried }) {
  return Boolean(hasSavedCredential) && !savedCredentialTried;
}
