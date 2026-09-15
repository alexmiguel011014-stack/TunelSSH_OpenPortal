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

function runStatus(execFile, binary) {
  return new Promise((resolve) => {
    execFile(binary, ['status', '--json'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

// Resolves a Tailscale login (email) to that peer's current IPv4 Tailscale
// address via `tailscale status --json` — used by GOALS 4 to push activity
// events to each configured `reportTo` identity without hardcoding its IP
// (a peer's IP is stable per-device, but this also means the professor can
// switch devices later without reconfiguring every target machine).
// Peers only carry a UserID in modern `tailscale status --json` output; the
// login (LoginName) lives in the top-level `User` map keyed by that same id
// — confirmed against a live install rather than assumed. Never throws:
// missing binary, stopped tailscaled, or no matching/reachable peer all
// resolve to null, which callers treat as "drop this push silently".
async function resolveLoginToIp(login, deps = {}) {
  const execFile = deps.execFile || nodeExecFile;
  const existsSync = deps.existsSync || nodeFs.existsSync;
  if (!login) return null;

  const tryBinary = async (binary) => {
    const status = await runStatus(execFile, binary);
    if (!status) return null;
    const users = status.User || {};
    const matchingIds = new Set(
      Object.entries(users)
        .filter(([, u]) => u?.LoginName === login)
        .map(([id]) => id),
    );
    if (matchingIds.size === 0) return null;
    for (const peer of Object.values(status.Peer || {})) {
      if (!matchingIds.has(String(peer.UserID)) || !Array.isArray(peer.TailscaleIPs)) continue;
      const ipv4 = peer.TailscaleIPs.find((ip) => ip.includes('.'));
      if (ipv4) return ipv4;
    }
    return null;
  };

  const ip = await tryBinary('tailscale');
  if (ip) return ip;
  if (existsSync(FALLBACK_BINARY)) {
    return await tryBinary(FALLBACK_BINARY);
  }
  return null;
}

module.exports = { resolveIdentity, resolveLoginToIp, normalizeIp, isAllowed };
