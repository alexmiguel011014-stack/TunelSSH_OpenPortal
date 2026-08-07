#!/usr/bin/env node
// Generates a dev-style version (e.g. 1.0.5-dev.20260804.142233) for the
// nightly workflow and writes it back to package.json. Safe to run locally
// and on CI; overwrites only the `version` field.
//
// IMPORTANT: the patch number is bumped by 1 before appending "-dev.<ts>".
// Per SemVer, a prerelease tag is LOWER precedence than its own base
// version (1.0.4-dev.1 < 1.0.4) — so if we tagged dev builds off the
// CURRENT stable version, electron-updater would never see them as an
// update for anyone already on that stable release, no matter how many
// nightly builds get published. Bumping to the next patch first guarantees
// every dev build compares as newer than the last real release.
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

const base = pkg.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
if (!match) {
  throw new Error(`[bump-dev] version "${base}" em package.json não é X.Y.Z puro (já contém um sufixo de pré-release?)`);
}
const [, major, minor, patch] = match;
const nextBase = `${major}.${minor}.${Number(patch) + 1}`;

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const next = `${nextBase}-dev.${ts}`;

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[bump-dev] version set to ${next} (base ${base} -> ${nextBase})`);
