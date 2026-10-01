import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import bumpModule from '../bump-dev-version.js';

const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { nightlyVersion } = bumpModule;

// Expressão oficial do semver.org.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe('nightlyVersion', () => {
  it('bumps the patch and stamps a beta prerelease', () => {
    expect(nightlyVersion('1.0.6', new Date('2026-09-30T20:57:39Z'))).toBe(
      '1.0.7-beta.20260930.205739',
    );
  });

  it('stays valid SemVer before 10:00 UTC (no leading zeros)', () => {
    expect(nightlyVersion('1.0.6', new Date('2026-10-01T09:30:12Z'))).toBe(
      '1.0.7-beta.20261001.93012',
    );
    expect(nightlyVersion('1.0.6', new Date('2026-10-01T00:00:05Z'))).toBe('1.0.7-beta.20261001.5');
    for (const iso of ['2026-10-01T00:00:00Z', '2026-10-01T09:05:07Z', '2026-12-31T23:59:59Z']) {
      expect(nightlyVersion('1.0.6', new Date(iso))).toMatch(SEMVER);
    }
  });

  it('refuses a version that already has a prerelease suffix', () => {
    expect(() => nightlyVersion('1.0.7-beta.1', new Date())).toThrow(/X\.Y\.Z/);
  });
});

// O electron-updater de verdade lendo releases falsas do GitHub: o feed .atom
// (mais nova primeiro) e o arquivo de canal (latest.yml, beta.yml) de cada tag.
async function latestFor(currentVersion, releases) {
  const requested = [];
  const executor = {
    async request(options) {
      requested.push(options.path);
      if (options.path.endsWith('.atom')) {
        const entries = releases
          .map(
            ({ tag }) =>
              `<entry><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/${tag}"/><title>${tag}</title><content type="html"></content></entry>`,
          )
          .join('');
        return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
      }
      const [, tag, file] = /\/download\/([^/]+)\/([^/]+)$/.exec(options.path);
      const release = releases.find((r) => r.tag === tag);
      if (!release?.files.includes(file)) throw new Error(`404 ${file}`);
      const exe = `OpenPortal-Remote-Setup-${release.version}.exe`;
      return [
        `version: ${release.version}`,
        'files:',
        `  - url: ${exe}`,
        '    sha512: x',
        '    size: 1',
        `path: ${exe}`,
        'sha512: x',
        "releaseDate: '2026-09-30T21:00:00.000Z'",
        '',
      ].join('\n');
    },
  };
  const provider = new GitHubProvider(
    { provider: 'github', owner: 'o', repo: 'r' },
    { allowPrerelease: true, currentVersion, channel: null },
    { executor, platform: 'win32' },
  );
  const info = await provider.getLatestVersion();
  return {
    version: info.version,
    channelFile: requested.at(-1).split('/').pop(),
  };
}

const stable = { tag: 'v1.0.6', version: '1.0.6', files: ['latest.yml'] };
const nightly = (version) => ({
  tag: `v${version}`,
  version,
  files: ['latest.yml', 'beta.yml'],
});

describe('update channel of nightly builds', () => {
  it('reproduces the stuck install: a -dev build finds nothing under the old dev-latest tag', async () => {
    const devLatest = {
      tag: 'dev-latest',
      version: '1.0.7-dev.20260930.205739',
      files: ['latest.yml'],
    };
    await expect(latestFor('1.0.7-dev.20260930.205739', [devLatest, stable])).rejects.toThrow(
      /No published versions on GitHub/,
    );
  });

  it('an installed nightly finds the next nightly', async () => {
    const next = nightly('1.0.7-beta.20261001.93012');
    expect(await latestFor('1.0.7-beta.20260930.205739', [next, stable])).toEqual({
      version: '1.0.7-beta.20261001.93012',
      channelFile: 'beta.yml',
    });
  });

  it('an installed nightly moves to a newer stable release', async () => {
    const release = { tag: 'v1.0.7', version: '1.0.7', files: ['latest.yml'] };
    const older = nightly('1.0.7-beta.20261001.93012');
    expect(await latestFor('1.0.7-beta.20261001.93012', [release, older, stable])).toEqual({
      version: '1.0.7',
      channelFile: 'latest.yml',
    });
  });

  it('a stable install is still offered the newest nightly', async () => {
    expect(await latestFor('1.0.6', [nightly('1.0.7-beta.20261001.93012'), stable])).toEqual({
      version: '1.0.7-beta.20261001.93012',
      channelFile: 'beta.yml',
    });
  });

  it('the nightly job publishes under the version tag, with beta.yml', () => {
    const yml = readFileSync(
      new URL('../../.github/workflows/nightly.yml', import.meta.url),
      'utf8',
    );
    expect(yml).toContain('tag_name: v${{ steps.stage.outputs.version }}');
    expect(yml).toMatch(/^\s+beta\.yml\r?$/m);
    expect(yml).not.toContain('tag_name: dev-latest');
  });
});
