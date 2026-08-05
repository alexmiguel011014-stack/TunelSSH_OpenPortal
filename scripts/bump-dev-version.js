#!/usr/bin/env node
// Generates a dev-style version (e.g. 1.0.4-dev.20260804.142233) for the
// nightly workflow and writes it back to package.json. Safe to run locally
// and on CI; overwrites only the `version` field.
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

const base = pkg.version;
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '.');
const next = `${base}-dev.${ts}`;

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[bump-dev] version set to ${next}`);
