import crypto from 'crypto';
import net from 'net';
import { describe, expect, it } from 'vitest';
import {
  buildAllowDirectVncScript,
  buildApplyVncPasswordScript,
  decideSetupOutcome,
  generateVncPassword,
  parseServiceExe,
  probeVncExposure,
  relaunchTightVncTray,
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

  it('makes TightVNC accept only local connections when applying the password', () => {
    const script = buildApplyVncPasswordScript('Ab3dEf7h');
    expect(script).toContain("-Name 'AllowLoopback' -Value 1 -Type DWord");
    expect(script).toContain("-Name 'LoopbackOnly' -Value 1 -Type DWord");
    expect(script.indexOf('LoopbackOnly')).toBeLessThan(script.indexOf('Restart-Service'));
  });

  it('offers a way back that reopens 5900 without touching the password', () => {
    const script = buildAllowDirectVncScript();
    expect(script).toContain("-Name 'LoopbackOnly' -Value 0 -Type DWord");
    expect(script).toContain('Restart-Service -Name tvnserver');
    expect(script).not.toContain('Password');
  });
});

describe('decideSetupOutcome', () => {
  it('claims local-only protection only when 5900 no longer answers on the network', () => {
    expect(decideSetupOutcome({ verdict: 'ok', exposure: 'closed' })).toEqual({
      store: true,
      localOnly: true,
      error: '',
    });
    expect(decideSetupOutcome({ verdict: 'ok', exposure: 'open' })).toEqual({
      store: true,
      localOnly: false,
      error: 'exposed',
    });
  });

  it('never stores a password the local login did not confirm', () => {
    for (const verdict of ['wrong', 'refused', 'no-auth', 'error']) {
      expect(decideSetupOutcome({ verdict, exposure: 'closed' })).toMatchObject({
        store: false,
        localOnly: false,
        error: verdict,
      });
    }
  });
});

describe('probeVncExposure', () => {
  it('tells an open VNC server from a refusing one and from a closed port, without authenticating', async () => {
    const open = await startFakeVncServer({ types: [2, 16] });
    const refusing = await startFakeVncServer({ types: [] });
    const closed = await startFakeVncServer();
    const closedPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    try {
      expect(await probeVncExposure('127.0.0.1', open.address().port)).toBe('open');
      expect(await probeVncExposure('127.0.0.1', refusing.address().port)).toBe('refused');
      expect(await probeVncExposure('127.0.0.1', closedPort, { timeoutMs: 1000 })).toBe('closed');
    } finally {
      open.close();
      refusing.close();
    }
  });
});

describe('TightVNC tray icon relaunch', () => {
  const imagePath =
    '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\tvnserver\r\n    ImagePath    REG_EXPAND_SZ    "C:\\Program Files\\TightVNC\\tvnserver.exe" -service\r\n';

  it('reads the service executable from reg query output, quoted or not', () => {
    expect(parseServiceExe(imagePath)).toBe('C:\\Program Files\\TightVNC\\tvnserver.exe');
    expect(parseServiceExe('    ImagePath    REG_SZ    C:\\VNC\\tvnserver.exe -service')).toBe(
      'C:\\VNC\\tvnserver.exe',
    );
    expect(parseServiceExe('')).toBe('');
  });

  function fakes(tasklistOutput) {
    const spawned = [];
    const execFile = (cmd, args, opts, cb) =>
      cb(null, cmd === 'tasklist' ? tasklistOutput : imagePath);
    const spawn = (exe, args) => {
      spawned.push({ exe, args });
      return { unref() {} };
    };
    return { spawned, execFile, spawn };
  }

  it('reopens the service control interface unelevated when only the service is running', async () => {
    const f = fakes('"tvnserver.exe","5992","Services","0","9.876 K"\r\n');
    expect(await relaunchTightVncTray(f)).toBe(true);
    expect(f.spawned).toEqual([
      { exe: 'C:\\Program Files\\TightVNC\\tvnserver.exe', args: ['-controlservice', '-slave'] },
    ]);
  });

  it('does nothing when the tray icon is already open in the user session', async () => {
    const f = fakes(
      '"tvnserver.exe","5992","Services","0","9.876 K"\r\n"tvnserver.exe","7001","Console","1","4.321 K"\r\n',
    );
    expect(await relaunchTightVncTray(f)).toBe(false);
    expect(f.spawned).toEqual([]);
  });
});
