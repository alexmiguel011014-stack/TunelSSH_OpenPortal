import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// O script que baixa e instala o Tailscale e o TightVNC (GOALS 22) roda com permissão de
// administrador no PC de quem usa o app: estes testes seguram o que ele pode e o que não pode fazer.
const SCRIPT = path.resolve(__dirname, '../../../../resources/prereqs/install-prereq.ps1');
const source = fs.readFileSync(SCRIPT, 'utf8');
const OFFICIAL_HOSTS = ['pkgs.tailscale.com', 'www.tightvnc.com'];

function catalogEntries() {
  const entries = {};
  const pattern = /^\s{2}(\w+) = @\{([\s\S]*?)^\s{2}\}/gm;
  for (const match of source.matchAll(pattern)) {
    const body = match[2];
    entries[match[1]] = {
      url: /Url\s*=\s*'([^']+)'/.exec(body)?.[1],
      hosts: [...(/Hosts\s*=\s*@\(([^)]*)\)/.exec(body)?.[1] || '').matchAll(/'([^']+)'/g)].map(
        (m) => m[1],
      ),
      signers: [...(/Signers\s*=\s*@\(([^)]*)\)/.exec(body)?.[1] || '').matchAll(/'([^']+)'/g)].map(
        (m) => m[1],
      ),
      args: body,
    };
  }
  return entries;
}

describe('install-prereq.ps1 (análise do texto)', () => {
  it('é UTF-8 com BOM (o Windows PowerShell 5.1 lê os acentos errado sem ele)', () => {
    const head = fs.readFileSync(SCRIPT).subarray(0, 3);
    expect([...head]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('tem só os dois programas no catálogo', () => {
    expect(Object.keys(catalogEntries()).sort()).toEqual(['tailscale', 'tightvnc']);
  });

  it('só baixa por https de sites oficiais, e o site confere com a lista do próprio item', () => {
    for (const [name, entry] of Object.entries(catalogEntries())) {
      const url = new URL(entry.url);
      expect(url.protocol, name).toBe('https:');
      expect(OFFICIAL_HOSTS, name).toContain(url.hostname);
      expect(entry.hosts, name).toEqual([url.hostname]);
    }
  });

  it('os assinantes são os que estão nos certificados dos MSI (lidos em 2026-10-28)', () => {
    // O campo Manufacturer do MSI do TightVNC diz "GlavSoft LLC", mas o certificado diz "OOO GlavSoft":
    // com o nome errado a instalação seria sempre recusada.
    expect(catalogEntries().tailscale.signers).toEqual(['Tailscale Inc.']);
    expect(catalogEntries().tightvnc.signers).toEqual(['OOO GlavSoft']);
  });

  it('o TightVNC fica na série 2.8, a que o app sabe configurar', () => {
    expect(catalogEntries().tightvnc.url).toMatch(
      /\/2\.8\.\d+\/tightvnc-2\.8\.\d+-gpl-setup-64bit\.msi$/,
    );
  });

  it('confere a assinatura antes de rodar o msiexec', () => {
    const signature = source.indexOf('Get-AuthenticodeSignature');
    const status = source.indexOf("-ne 'Valid'");
    const msiexec = source.indexOf("'msiexec.exe'");
    expect(signature).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(signature);
    expect(msiexec).toBeGreaterThan(status);
  });

  it('não executa texto de fora nem baixa código para rodar', () => {
    for (const forbidden of [
      /Invoke-Expression/i,
      /\biex\b/i,
      /-EncodedCommand/i,
      /DownloadString/i,
      /Set-ExecutionPolicy/i,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it('o TightVNC sobe só com conexões locais, sem firewall e sem senha na linha de comando', () => {
    const { args } = catalogEntries().tightvnc;
    expect(args).toContain('SERVER_ADD_FIREWALL_EXCEPTION=0');
    expect(args).toContain('VALUE_OF_LOOPBACKONLY=1');
    expect(args).toContain('VALUE_OF_USEVNCAUTHENTICATION=1');
    expect(args).not.toMatch(/PASSWORD/i);
  });

  it('mapeia o msiexec 0 e 3010 para sucesso (3010 pede reinício) e os códigos de falha', () => {
    expect(source).toMatch(/\$code -eq 0\) \{ Finish \$true 0 /);
    expect(source).toMatch(/\$code -eq 3010\) \{ Finish \$true 2 3010 \$true /);
    expect(source).toMatch(/Finish \$false 11 /); // não baixou
    expect(source).toMatch(/Finish \$false 12 /); // assinatura
    expect(source).toMatch(/Finish \$false 13 /); // cancelado
    expect(source).toMatch(/Finish \$false 14 /); // msiexec falhou
  });
});

describe.skipIf(process.platform !== 'win32')('install-prereq.ps1 (no Windows)', () => {
  function powershell(script) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true },
    );
  }

  it('recusa um nome fora do catálogo, com código 10 e o resultado no arquivo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prereq-test-'));
    try {
      const resultFile = path.join(dir, 'result.json');
      const run = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT,
          '-Name',
          'tailscale; calc',
          '-ResultFile',
          resultFile,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(run.status).toBe(10);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(result.ok).toBe(false);
      expect(result.message).toContain('só instala');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('só aceita o assinante exato (o nome no certificado, e não em outro campo ou como prefixo)', () => {
    const fn = /function Test-SignerMatches[\s\S]*?\r?\n\}/.exec(source)[0];
    // Entre parênteses: como argumento de comando, o objeto precisa ser uma expressão.
    const cert = (subject) =>
      `([pscustomobject]@{ SignerCertificate = [pscustomobject]@{ Subject = '${subject}' } })`;
    const output = powershell(
      [
        fn,
        "$ts = @('Tailscale Inc.')",
        '$results = @(',
        `  (Test-SignerMatches ${cert('CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA')} $ts),`,
        `  (Test-SignerMatches ${cert('CN=Tailscale Inc.')} $ts),`,
        `  (Test-SignerMatches ${cert('CN=Evil Corp, O=Tailscale Inc., C=CA')} $ts),`,
        `  (Test-SignerMatches ${cert('CN=Tailscale Inc.X, O=Evil, C=CA')} $ts),`,
        `  (Test-SignerMatches ${cert('CN=NotTailscale Inc., C=CA')} $ts),`,
        '  (Test-SignerMatches ([pscustomobject]@{ SignerCertificate = $null }) $ts)',
        ')',
        '($results | ForEach-Object { [string]$_ }) -join ","',
      ].join('\n'),
    );
    expect(output.trim()).toBe('True,True,False,False,False,False');
  });

  it('aceita os assinantes reais do catálogo e recusa o nome do campo Manufacturer', () => {
    const fn = /function Test-SignerMatches[\s\S]*?\r?\n\}/.exec(source)[0];
    const cert = (subject) =>
      `([pscustomobject]@{ SignerCertificate = [pscustomobject]@{ Subject = '${subject}' } })`;
    // Os assuntos exatos dos certificados do Tailscale 1.104.4 e do TightVNC 2.8.90 (Get-AuthenticodeSignature).
    const tailscale =
      'CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA, SERIALNUMBER=1131559-5, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.3=CA';
    const tightvnc =
      'E=info@glavsoft.com, CN=OOO GlavSoft, O=OOO GlavSoft, L=Tomsk, S=Tomsk Oblast, C=RU';
    const { tailscale: ts, tightvnc: vnc } = catalogEntries();
    const list = (signers) => `@(${signers.map((s) => `'${s}'`).join(',')})`;
    const output = powershell(
      [
        fn,
        '$results = @(',
        `  (Test-SignerMatches ${cert(tailscale)} ${list(ts.signers)}),`,
        `  (Test-SignerMatches ${cert(tightvnc)} ${list(vnc.signers)}),`,
        `  (Test-SignerMatches ${cert(tightvnc)} @('GlavSoft LLC')),`,
        `  (Test-SignerMatches ${cert(tailscale)} ${list(vnc.signers)})`,
        ')',
        '($results | ForEach-Object { [string]$_ }) -join ","',
      ].join('\n'),
    );
    expect(output.trim()).toBe('True,True,False,False');
  });
});
