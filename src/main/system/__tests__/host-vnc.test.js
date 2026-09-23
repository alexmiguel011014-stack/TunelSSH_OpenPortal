import crypto from 'crypto';
import net from 'net';
import { describe, expect, it } from 'vitest';
import {
  buildApplyVncPasswordScript,
  generateVncPassword,
  reverseBits,
  vncAuthResponse,
  verifyVncPassword,
} from '../host-vnc.js';

// O Node do sistema (OpenSSL 3) não tem DES; o runtime do Electron tem.
const hasDes = (() => {
  try {
    crypto.createCipheriv('des-ecb', Buffer.alloc(8), null);
    return true;
  } catch {
    return false;
  }
})();

// Cifra falsa (XOR) só para exercitar o handshake RFB sem depender de DES.
function xorCipher(_algorithm, key) {
  return {
    setAutoPadding() {},
    update(data) {
      const out = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % 8];
      return out;
    },
    final: () => Buffer.alloc(0),
  };
}

function startFakeVncServer({ types = [2, 16], password = 'Secret12' } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const challenge = crypto.randomBytes(16);
      let stage = 'version';
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.write('RFB 003.008\n');
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'version' && buffer.length >= 12) {
          buffer = buffer.subarray(12);
          stage = 'type';
          socket.write(Buffer.from([types.length, ...types]));
          if (types.length === 0) socket.end();
        }
        if (stage === 'type' && buffer.length >= 1) {
          buffer = buffer.subarray(1);
          stage = 'response';
          socket.write(challenge);
        }
        if (stage === 'response' && buffer.length >= 16) {
          const expected = vncAuthResponse(password, challenge, xorCipher);
          socket.end(Buffer.from([0, 0, 0, expected.equals(buffer.subarray(0, 16)) ? 0 : 1]));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function verifyAgainst(serverOpts, password) {
  const server = await startFakeVncServer(serverOpts);
  try {
    return await verifyVncPassword('127.0.0.1', server.address().port, password, {
      createCipheriv: xorCipher,
    });
  } finally {
    server.close();
  }
}

describe('verifyVncPassword', () => {
  it('confirms a password the VNC server accepts', async () => {
    expect(await verifyAgainst({ password: 'Secret12' }, 'Secret12')).toBe('ok');
  });

  it('reports a password the VNC server rejects', async () => {
    expect(await verifyAgainst({ password: 'Secret12' }, 'Other123')).toBe('wrong');
  });

  it('reports a refusal before authentication (IP blocked by TightVNC)', async () => {
    expect(await verifyAgainst({ types: [] }, 'Secret12')).toBe('refused');
  });

  it('reports a server that does not use a password', async () => {
    expect(await verifyAgainst({ types: [1] }, 'Secret12')).toBe('no-auth');
  });
});

describe('VNC password primitives', () => {
  it('reverses the bits of each key byte like the VNC d3des', () => {
    expect(reverseBits(23)).toBe(0xe8);
    expect(reverseBits(7)).toBe(0xe0);
    expect(reverseBits(0x80)).toBe(0x01);
  });

  it.skipIf(!hasDes)('matches the classic VNC DES vector ("password" under the fixed key)', () => {
    const fixedKeyAsPassword = String.fromCharCode(23, 82, 107, 6, 35, 78, 88, 7);
    expect(vncAuthResponse(fixedKeyAsPassword, Buffer.from('password')).toString('hex')).toBe(
      'dbd83cfd727a1458',
    );
  });

  it('generates 8 unambiguous characters (VNC only uses 8)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVncPassword()).toMatch(
        /^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz2-9]{8}$/,
      );
    }
  });

  it('builds the elevated script with the fixed TightVNC key and without the plaintext', () => {
    const script = buildApplyVncPasswordScript('Ab3dEf7h');
    expect(script).toContain("'HKLM:\\SOFTWARE\\TightVNC\\Server'");
    expect(script).toContain('0xE8,0x4A,0xD6,0x60,0xC4,0x72,0x1A,0xE0');
    expect(script).toContain('65,98,51,100,69,102,55,104');
    expect(script).toContain('Restart-Service -Name tvnserver');
    expect(script).not.toContain('Ab3dEf7h');
  });
});
