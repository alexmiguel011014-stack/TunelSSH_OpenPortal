import { describe, expect, it } from 'vitest';
import {
  SessionPasswordGate,
  generateSessionPassword,
  MAX_FAILURES,
  LOCKOUT_MS,
} from '../session-password.js';

const fixed = () => 'ABCD-EFGH';

describe('generateSessionPassword', () => {
  it('produces an 8-character dictation-friendly password formatted as XXXX-XXXX', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSessionPassword()).toMatch(
        /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/,
      );
    }
  });
});

describe('SessionPasswordGate', () => {
  it('accepts the current password however it is typed', () => {
    const gate = new SessionPasswordGate({ generate: fixed });
    expect(gate.check('100.1.1.1', 'abcd efgh')).toBe('ok');
    expect(gate.check('100.1.1.1', 'ABCDEFGH')).toBe('ok');
  });

  it('rejects a wrong or empty password', () => {
    const gate = new SessionPasswordGate({ generate: fixed });
    expect(gate.check('100.1.1.1', 'ABCD-EFGX')).toBe('wrong');
    expect(gate.check('100.1.1.1', '')).toBe('wrong');
  });

  it('locks an IP out after repeated wrong passwords, even for the right one, until it expires', () => {
    let now = 1000;
    const gate = new SessionPasswordGate({ generate: fixed, now: () => now });
    for (let i = 1; i < MAX_FAILURES; i++) expect(gate.check('100.1.1.1', 'nope')).toBe('wrong');
    expect(gate.check('100.1.1.1', 'nope')).toBe('locked');
    expect(gate.check('100.1.1.1', 'ABCD-EFGH')).toBe('locked');
    expect(gate.check('100.2.2.2', 'ABCD-EFGH')).toBe('ok');
    now += LOCKOUT_MS + 1;
    expect(gate.check('100.1.1.1', 'ABCD-EFGH')).toBe('ok');
  });

  it('rotate replaces the password, invalidates the old one and announces the change', () => {
    const values = ['AAAA-AAAA', 'BBBB-BBBB'];
    const gate = new SessionPasswordGate({ generate: () => values.shift() });
    let rotated = 0;
    gate.on('rotated', () => rotated++);
    expect(gate.password).toBe('AAAA-AAAA');
    gate.rotate();
    expect(gate.password).toBe('BBBB-BBBB');
    expect(gate.check('100.1.1.1', 'AAAA-AAAA')).toBe('wrong');
    expect(rotated).toBe(1);
  });
});
