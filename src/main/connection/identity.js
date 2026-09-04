'use strict';

const nodeExecFile = require('child_process').execFile;
const nodeFs = require('fs');

// Tailscale's GUI install on Windows doesn't always put the CLI on PATH —
// fall back to the known default install location before giving up.
const FALLBACK_BINARY = 'C:\\Program Files\\Tailscale\\tailscale.exe';

function normalizeIp(address) {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function runWhois(execFile, binary, ip) {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['whois', '--json', ip],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const data = JSON.parse(stdout);
          resolve(data?.UserProfile?.LoginName || null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// Resolves the verified Tailscale login (email) behind a peer IP via
// `tailscale whois --json`. Never throws: a missing binary, a stopped
// tailscaled, or an IP that isn't a tailnet peer all resolve to 'unknown' so
// callers fall back to manual approval instead of crashing or blocking the
// connection-request flow. `ip` must be the real socket remote address, not
// a self-reported value from the wire protocol — otherwise a client could
// simply claim to be someone else's IP and bypass the allow-list.
//
// `deps` defaults to the real Node child_process/fs and only exists so tests
// can inject fakes directly — module-mocking `child_process`/`fs` isn't
// reliable for a plain `require()` in this project's Vitest setup.
async function resolveIdentity(ip, deps = {}) {
  const execFile = deps.execFile || nodeExecFile;
  const existsSync = deps.existsSync || nodeFs.existsSync;

  const target = normalizeIp(ip);
  if (!target) return 'unknown';
  const login = await runWhois(execFile, 'tailscale', target);
  if (login) return login;
  if (existsSync(FALLBACK_BINARY)) {
    const fallbackLogin = await runWhois(execFile, FALLBACK_BINARY, target);
    if (fallbackLogin) return fallbackLogin;
  }
  return 'unknown';
}

// Never treats 'unknown' as a match, even if a caller's own allow-list were
// ever misconfigured to contain the literal string 'unknown'.
function isAllowed(identity, allowedUsers) {
  return identity !== 'unknown' && Array.isArray(allowedUsers) && allowedUsers.includes(identity);
}

module.exports = { resolveIdentity, normalizeIp, isAllowed };
