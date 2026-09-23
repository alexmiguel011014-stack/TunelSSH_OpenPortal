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

// Campo de IP: só dígitos e pontos (vírgula e espaço viram ponto), porta
// descartada, no máximo 4 octetos de até 255, e o ponto entra sozinho quando
// o octeto não comporta mais dígitos ("100", "81") — só enquanto se digita,
// para apagar funcionar.
export function formatIpInput(value, previous = '') {
  const raw = String(value || '')
    .split(':')[0]
    .replace(/[,\s]/g, '.');
  const octets = [''];
  const isFull = (octet) => octet.length === 3 || Number(octet) * 10 > 255;
  for (const ch of raw) {
    const last = octets.length - 1;
    if (ch === '.') {
      if (octets[last] && octets.length < 4) octets.push('');
    } else if (/\d/.test(ch)) {
      const grown = octets[last] + ch;
      if (grown.length <= 3 && Number(grown) <= 255) octets[last] = grown;
      else if (octets.length < 4) octets.push(ch);
    }
  }
  const out = octets.join('.');
  const typing = out.length > String(previous || '').length;
  const lastOctet = octets[octets.length - 1];
  return typing && octets.length < 4 && lastOctet && isFull(lastOctet) ? `${out}.` : out;
}

// Campo "senha de acesso": maiúsculas, só letras e números, com o traço
// automático depois dos 4 primeiros (formato XXXX-XXXX mostrado no outro PC).
export function formatAccessPassword(value) {
  const chars = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
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
