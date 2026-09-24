import { describe, expect, it } from 'vitest';
import credentials from '../machine-credentials.js';

const { mergeStoredMachine, toRendererMachine } = credentials;
const encrypt = (value) => ({ enc: `encrypted:${value}` });

describe('VNC credential config boundary', () => {
  it('reports only that a stored VNC password exists to the renderer', () => {
    const machine = toRendererMachine({
      id: 'pc-b',
      host: '100.81.199.56',
      passwordEnc: { enc: 'encrypted:secret' },
    });
    expect(machine).toMatchObject({ id: 'pc-b', hasVncPassword: true });
    expect(machine).not.toHaveProperty('password');
    expect(machine).not.toHaveProperty('passwordEnc');
  });

  it('preserves an existing encrypted credential when a normal machine save omits password', () => {
    const existing = { id: 'pc-b', name: 'PC B', passwordEnc: { enc: 'old' } };
    const saved = mergeStoredMachine(existing, { id: 'pc-b', name: 'PC B novo' }, encrypt);
    expect(saved).toMatchObject({ name: 'PC B novo', passwordEnc: { enc: 'old' } });
  });

  it('can replace or clear a credential without retaining plaintext', () => {
    const existing = { id: 'pc-b', passwordEnc: { enc: 'old' } };
    expect(mergeStoredMachine(existing, { id: 'pc-b', password: 'new-value' }, encrypt)).toEqual({
      id: 'pc-b',
      passwordEnc: { enc: 'encrypted:new-value' },
    });
    expect(mergeStoredMachine(existing, { id: 'pc-b', password: '' }, encrypt)).toEqual({
      id: 'pc-b',
    });
  });
});
