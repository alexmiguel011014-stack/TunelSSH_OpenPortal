import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// O serviço do laboratório (C#, GOALS 17) leva os próprios testes dentro do
// executável: `--selftest` roda o motor contra um Windows falso, sem criar ou
// alterar nada de verdade. Aqui o Vitest os executa no Windows; sem o .exe
// compilado (Linux, ou ainda sem MSBuild) esta suíte é pulada e o CI do Windows
// roda o mesmo --selftest direto, depois de compilar (nightly.yml).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const serviceDir = path.join(root, 'lab-service');

function newestBuild() {
  const builds = ['Debug', 'Release']
    .map((config) => path.join(serviceDir, 'bin', config, 'OpenPortalLabService.exe'))
    .filter((file) => existsSync(file));
  builds.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return builds[0] || null;
}

function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'bin' || entry.name === 'obj') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(cs|csproj)$/.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(serviceDir);
  return newest;
}

const exe = process.platform === 'win32' ? newestBuild() : null;

describe.skipIf(!exe)('lab service binary', () => {
  it('was built after the last change to its sources', () => {
    expect(
      statSync(exe).mtimeMs >= newestSource(),
      'lab-service/bin está desatualizado: recompile com MSBuild (lab-service/OpenPortalLabService.csproj)',
    ).toBe(true);
  });

  it('passes its own self-test (engine, protocol, names, capacity, state)', () => {
    const run = spawnSync(exe, ['--selftest'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const report = JSON.parse(run.stdout);
    const failures = report.results.filter((result) => !result.ok);
    expect(failures.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(run.status).toBe(0);
    expect(report.total).toBeGreaterThanOrEqual(40);
  });

  it('the self-test covers the rules the plan names', () => {
    const report = JSON.parse(
      execFileSync(exe, ['--selftest'], { encoding: 'utf8', timeout: 60_000 }),
    );
    const names = report.results.map((r) => r.name).join('\n');
    for (const topic of [
      'recommendation table',
      'one warning five minutes before the end',
      'at most one student account is ever enabled',
      'the deadline is still honoured after the service restarts',
      'will not log off',
      'password appears only in the reserve answer',
      'SYSTEM and the owner only',
    ]) {
      expect(names, `faltou o teste: ${topic}`).toContain(topic);
    }
  });

  it('refuses to run as a plain console program without a mode', () => {
    const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 15_000 });
    expect(run.status).toBe(2);
  });

  it('--probe only reads: it reports this machine and never finds a made-up account', () => {
    const report = JSON.parse(
      execFileSync(exe, ['--probe'], { encoding: 'utf8', timeout: 60_000 }),
    );
    expect(typeof report.machine).toBe('string');
    expect(report.missingAccountExists).toBe(false);
    expect(typeof report.elevated).toBe('boolean');
    expect(report.diskTotalGb).toBeGreaterThan(0);
  });
});
