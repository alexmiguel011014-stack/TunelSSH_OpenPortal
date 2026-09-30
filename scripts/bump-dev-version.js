#!/usr/bin/env node
// Generates the nightly version (e.g. 1.0.7-beta.20260930.205739) for the
// nightly workflow and writes it back to package.json. Safe to run locally
// and on CI; overwrites only the `version` field.
//
// IMPORTANT: the patch number is bumped by 1 before the prerelease suffix.
// Per SemVer, a prerelease tag is LOWER precedence than its own base
// version (1.0.4-beta.1 < 1.0.4) — so if we tagged nightly builds off the
// CURRENT stable version, electron-updater would never see them as an
// update for anyone already on that stable release, no matter how many
// nightly builds get published. Bumping to the next patch first guarantees
// every nightly build compares as newer than the last real release.
//
// "beta", not "dev" (2026-09-30): electron-updater takes the channel of an
// installed prerelease from this suffix and, outside alpha/beta, only accepts
// releases of that same channel. An installed "-dev" build found none it could
// use ("No published versions on GitHub") and never updated again; a "-beta"
// build follows the newest beta or stable release. SemVer also forbids leading
// zeros in numeric identifiers, so the time goes in as a number
// (09:30:12 -> 93012), which keeps the order within the day.
const fs = require('fs');
const path = require('path');

function nightlyVersion(base, date) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match) {
    throw new Error(
      `[bump-dev] version "${base}" em package.json não é X.Y.Z puro (já contém um sufixo de pré-release?)`,
    );
  }
  const [, major, minor, patch] = match;
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const time = date.getUTCHours() * 10000 + date.getUTCMinutes() * 100 + date.getUTCSeconds();
  return `${major}.${minor}.${Number(patch) + 1}-beta.${day}.${time}`;
}

if (require.main === module) {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const next = nightlyVersion(pkg.version, new Date());
  console.log(`[bump-dev] version set to ${next} (base ${pkg.version})`);
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

module.exports = { nightlyVersion };
