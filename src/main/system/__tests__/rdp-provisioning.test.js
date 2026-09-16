import { describe, it, expect } from 'vitest';
import {
  buildEnableHostingScript,
  buildCreateCredentialScript,
  runElevatedPowerShell,
  verifyRdpHostingEnabled,
  enableRdpHosting,
  generatePassword,
} from '../rdp-provisioning.js';

describe('buildEnableHostingScript', () => {
  it('sets fDenyTSConnections to 0 and enables the firewall group', () => {
    const script = buildEnableHostingScript();
    expect(script).toContain("Name 'fDenyTSConnections' -Value 0");
    expect(script).toContain('Enable-NetFirewallRule -DisplayGroup "Remote Desktop"');
  });
});

describe('buildCreateCredentialScript', () => {
  it('creates the user and adds it to Remote Desktop Users', () => {
    const script = buildCreateCredentialScript('openportal-rdp', 'S3cret!');
    expect(script).toContain("New-LocalUser -Name 'openportal-rdp'");
    expect(script).toContain(
      "Add-LocalGroupMember -Group 'Remote Desktop Users' -Member 'openportal-rdp'",
    );
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
  it('returns true when the registry value reads back as 0', async () => {
    const spawn = makeFakeSpawn({ stdout: '0\r\n' });
    await expect(verifyRdpHostingEnabled({ spawn })).resolves.toBe(true);
  });

  it('returns false for any other value', async () => {
    const spawn = makeFakeSpawn({ stdout: '1\r\n' });
    await expect(verifyRdpHostingEnabled({ spawn })).resolves.toBe(false);
  });
});

describe('enableRdpHosting', () => {
  it('runs the elevated script then verifies the registry value', async () => {
    const spawn = makeFakeSpawn({ exitCode: 0, stdout: '0' });
    await expect(enableRdpHosting({ spawn })).resolves.toBe(true);
    expect(spawn.calls.length).toBe(2);
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
