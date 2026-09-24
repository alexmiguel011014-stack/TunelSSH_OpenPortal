import { describe, it, expect } from 'vitest';
import {
  buildEnableHostingScript,
  buildCreateCredentialScript,
  runElevatedPowerShell,
  parseHostingState,
  verifyRdpHostingEnabled,
  enableRdpHosting,
  createRdpCredential,
  generatePassword,
} from '../rdp-provisioning.js';

describe('buildEnableHostingScript', () => {
  it('turns RDP on and opens 3389 only to the Tailscale range', () => {
    const script = buildEnableHostingScript();
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("Name 'fDenyTSConnections' -Value 0");
    expect(script).toContain('Start-Service -Name TermService');
    expect(script).toContain("New-NetFirewallRule -Name 'OpenPortal-RDP-Tailscale'");
    expect(script).toContain("-LocalPort 3389 -RemoteAddress '100.64.0.0/10'");
  });

  it("does not touch Windows' Remote Desktop group, which is open to any network and localized", () => {
    const script = buildEnableHostingScript();
    expect(script).not.toContain('Enable-NetFirewallRule');
    expect(script).not.toContain('DisplayGroup');
  });
});

describe('buildCreateCredentialScript', () => {
  it('creates the user and adds it to Remote Desktop Users by SID', () => {
    const script = buildCreateCredentialScript('openportal-rdp', 'S3cret!');
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("New-LocalUser -Name 'openportal-rdp'");
    expect(script).toContain("Add-LocalGroupMember -SID 'S-1-5-32-555' -Member 'openportal-rdp'");
    expect(script).not.toContain("'Remote Desktop Users'");
    expect(script).toContain('S3cret!');
  });

  it('escapes single quotes in the username to avoid breaking out of the PowerShell string', () => {
    const script = buildCreateCredentialScript("o'brien", 'pw');
    expect(script).toContain("o''brien");
  });
});

function makeFakeSpawn({ exitCode = 0, stdout = '' } = {}) {
  const calls = [];
  function spawnFn(cmd, args) {
    calls.push({ cmd, args });
    const listeners = {};
    return {
      stdout: {
        on: (event, cb) => {
          if (event === 'data' && stdout) cb(stdout);
        },
      },
      on: (event, cb) => {
        listeners[event] = cb;
        if (event === 'exit') setTimeout(() => cb(exitCode), 0);
        if (event === 'close') setTimeout(() => cb(exitCode), 0);
      },
    };
  }
  spawnFn.calls = calls;
  return spawnFn;
}

describe('runElevatedPowerShell', () => {
  it('resolves when the elevated process exits 0', async () => {
    const spawn = makeFakeSpawn({ exitCode: 0 });
    await expect(runElevatedPowerShell('Get-Date', { spawn })).resolves.toBeUndefined();
    expect(spawn.calls[0].cmd).toBe('powershell.exe');
  });

  it('rejects when the elevated process exits non-zero (e.g. UAC declined)', async () => {
    const spawn = makeFakeSpawn({ exitCode: 1 });
    await expect(runElevatedPowerShell('Get-Date', { spawn })).rejects.toThrow();
  });
});

describe('verifyRdpHostingEnabled', () => {
  it('needs RDP allowed, the Tailscale-only rule enabled and the service running', async () => {
    expect(parseHostingState('0|True|Running\r\n')).toBe(true);
    expect(parseHostingState('1|True|Running')).toBe(false);
    expect(parseHostingState('0|missing|Running')).toBe(false);
    expect(parseHostingState('0|False|Running')).toBe(false);
    expect(parseHostingState('0|True|Stopped')).toBe(false);
    expect(parseHostingState('')).toBe(false);
    const spawn = makeFakeSpawn({ stdout: '0|True|Running\r\n' });
    await expect(verifyRdpHostingEnabled({ spawn })).resolves.toBe(true);
  });
});

describe('enableRdpHosting', () => {
  it('runs the elevated script then reads the state back', async () => {
    const spawn = makeFakeSpawn({ exitCode: 0, stdout: '0|True|Running' });
    await expect(enableRdpHosting({ spawn })).resolves.toBe(true);
    expect(spawn.calls.length).toBe(2);
  });

  it('reports failure when the elevated script left the firewall rule missing', async () => {
    const spawn = makeFakeSpawn({ exitCode: 0, stdout: '0|missing|Running' });
    await expect(enableRdpHosting({ spawn })).resolves.toBe(false);
  });
});

describe('createRdpCredential', () => {
  it('succeeds only when the account reads back as a Remote Desktop user', async () => {
    await expect(
      createRdpCredential('openportal-rdp', 'pw', { spawn: makeFakeSpawn({ stdout: '1' }) }),
    ).resolves.toBeUndefined();
    await expect(
      createRdpCredential('openportal-rdp', 'pw', { spawn: makeFakeSpawn({ stdout: '0' }) }),
    ).rejects.toThrow('grupo de Área de Trabalho Remota');
  });
});

describe('generatePassword', () => {
  it('generates a non-empty string of the requested length', () => {
    const pw = generatePassword(24);
    expect(pw.length).toBe(24);
  });

  it('generates different passwords across calls', () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
