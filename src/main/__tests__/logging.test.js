import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import loggingModule from '../logging.js';

const { createRotatingLog } = loggingModule;
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createRotatingLog', () => {
  it('rotates while the app is running instead of growing without limit', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'op-log-'));
    dirs.push(dir);
    const file = path.join(dir, 'electron-out.log');
    const log = createRotatingLog(file, 1_000);

    for (let i = 0; i < 50; i++) log.write(`${String(i).padStart(3, '0')} ${'x'.repeat(95)}\n`);
    await log.close();

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(1_000);
    expect(readFileSync(file, 'utf8')).toContain('049 ');
  });
});
