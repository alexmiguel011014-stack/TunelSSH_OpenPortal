import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  SERVICE_NAME,
  buildDisableLabScript,
  buildEnableLabScript,
  readOwnerSid,
  readServiceStatus,
} from '../lab-provisioning.js';
import { buildEnableHostingScript } from '../rdp-provisioning.js';

const SOURCE =
  'C:\\Program Files\\OpenPortal Remote\\resources\\lab-service\\OpenPortalLabService.exe';
const OWNER = 'S-1-5-21-3355778429-1177510427-643378362-1001';
const enable = (options = {}) =>
  buildEnableLabScript({ serviceSource: SOURCE, ownerSid: OWNER, ...options });

// Só análise de sintaxe (nada é executado): o parser do próprio PowerShell acha um
// erro de aspas ou de bloco antes de o UAC abrir na frente do usuário.
function powerShellSyntaxErrors(script) {
  const quoted = script.replace(/'/g, "''");
  const run = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput('${quoted}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message } }`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return run.stdout.trim();
}

describe('enable lab mode script', () => {
  it('copies the service to a folder only administrators can change, then registers it', () => {
    const script = enable();
    expect(script).toContain("$dir = Join-Path $env:ProgramFiles 'OpenPortal Lab'");
    // SYSTEM e Administradores com controle total; usuários comuns só leem e executam.
    expect(script).toContain(
      "'*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX'",
    );
    expect(script).toContain('Copy-Item -LiteralPath $source -Destination $exe -Force');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('New-Service');
    expect(script).toContain('-StartupType Automatic');
    expect(script).toContain('Start-Service -Name $name');
    // Caminho com espaço: o executável vai entre aspas no registro do serviço.
    expect(script).toContain("-BinaryPathName ('\"' + $exe + '\"')");
  });

  it('stops an older service before replacing its executable', () => {
    const script = enable();
    expect(script.indexOf('Stop-Service')).toBeGreaterThan(-1);
    expect(script.indexOf('Stop-Service')).toBeLessThan(script.indexOf('Copy-Item'));
  });

  it('restarts the service by itself if it crashes', () => {
    expect(enable()).toContain(
      'sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/30000',
    );
  });

  it('writes the owner SID to a data folder closed to students', () => {
    const script = enable();
    expect(script).toContain(`'{"ownerSid":"${OWNER}","volume":"C:"}'`);
    expect(script).toContain("$data = Join-Path $env:ProgramData 'OpenPortal\\lab'");
    expect(script).toContain(
      "& icacls.exe $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'",
    );
    const dataLine = script.split('\n').find((l) => l.includes('icacls.exe $data'));
    expect(dataLine).not.toContain('S-1-5-32-545');
  });

  it('turns on disk quota tracking and enforcement on the profile volume, once', () => {
    const script = enable({ volume: 'D:' });
    expect(script).toContain('fsutil.exe quota track D:');
    expect(script).toContain('fsutil.exe quota enforce D:');
    expect(script).toContain('"volume":"D:"');
  });

  it('opens RDP hosting to the Tailscale range only, unless the students are on site', () => {
    const home = enable();
    expect(home).toContain(buildEnableHostingScript());
    expect(home).toContain("-RemoteAddress '100.64.0.0/10' ");
    expect(home).not.toContain('LocalSubnet');

    const onSite = enable({ studentsOnSite: true });
    expect(onSite).toContain("-RemoteAddress '100.64.0.0/10','LocalSubnet' ");
    expect(onSite).toContain(
      buildEnableHostingScript({
        remoteAddresses: ['100.64.0.0/10', 'LocalSubnet'],
      }),
    );
  });

  it('never carries a password, key or token', () => {
    expect(enable({ studentsOnSite: true })).not.toMatch(/passw|senha|secret|token|key/i);
  });

  it.each([
    ['a relative path', { serviceSource: 'lab-service\\OpenPortalLabService.exe' }],
    ['another file name', { serviceSource: 'C:\\x\\Other.exe' }],
    ['a quote in the path', { serviceSource: "C:\\x'; Remove-Item *\\OpenPortalLabService.exe" }],
    ['a SID with extra text', { ownerSid: `${OWNER}'; calc` }],
    ['a name that is not a SID', { ownerSid: 'Alex' }],
    ['an empty SID', { ownerSid: '' }],
    ['a volume with a path', { volume: 'C:\\Users' }],
    ['a lowercase volume', { volume: 'c:' }],
  ])('refuses to build the script with %s', (_, override) => {
    expect(() => enable(override)).toThrow();
  });
});

describe('disable lab mode script', () => {
  it('stops and removes the service but keeps the students and their data', () => {
    const script = buildDisableLabScript();
    expect(script).toContain('Stop-Service');
    expect(script).toContain('sc.exe delete $name');
    expect(script).toContain('Remove-Item -LiteralPath $dir -Recurse -Force');
    expect(script).toContain('Disable-LocalUser');
    // Contas e perfis ficam: nada apaga usuário, perfil ou a lista de alunos.
    expect(script).not.toMatch(/Remove-LocalUser|net user|\/delete/);
    expect(script).not.toMatch(/Remove-Item[^\n]*(state\.json|Users|ProgramData)/);
  });

  it('only disables accounts whose names look like student accounts', () => {
    expect(buildDisableLabScript()).toContain("-match '^[a-z0-9]{1,12}$'");
  });

  it('uses the same service name as the service itself', () => {
    expect(SERVICE_NAME).toBe('OpenPortalLab');
    expect(buildDisableLabScript()).toContain(`$name = '${SERVICE_NAME}'`);
    expect(enable()).toContain(`$name = '${SERVICE_NAME}'`);
  });
});

describe.skipIf(process.platform !== 'win32')('PowerShell syntax of the generated scripts', () => {
  it('parses without errors (nothing is executed)', () => {
    expect(powerShellSyntaxErrors(enable())).toBe('');
    expect(powerShellSyntaxErrors(enable({ studentsOnSite: true }))).toBe('');
    expect(powerShellSyntaxErrors(buildDisableLabScript())).toBe('');
  });

  it('the checker really notices a broken script', () => {
    expect(powerShellSyntaxErrors("if ($true) { 'sem fechar'")).not.toBe('');
  });
});

describe('reading the state back', () => {
  const fakeSpawn = (output) => () => {
    const handlers = {};
    return {
      stdout: {
        on: (event, fn) => event === 'data' && setImmediate(() => fn(output)),
      },
      on: (event, fn) => {
        handlers[event] = fn;
        if (event === 'close') setTimeout(() => fn(0), 5);
      },
    };
  };

  it('reads the service status, "missing" when there is none', async () => {
    expect(await readServiceStatus({ spawn: fakeSpawn('Running\r\n') })).toBe('Running');
    expect(await readServiceStatus({ spawn: fakeSpawn('Stopped') })).toBe('Stopped');
    expect(await readServiceStatus({ spawn: fakeSpawn('') })).toBe('missing');
  });

  it('reads the owner SID and rejects anything that is not one', async () => {
    expect(await readOwnerSid({ spawn: fakeSpawn(`${OWNER}\r\n`) })).toBe(OWNER);
    expect(await readOwnerSid({ spawn: fakeSpawn('erro qualquer') })).toBe('');
  });
});
