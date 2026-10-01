import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAgentSession } from '../file-agent.js';
import {
  FRAME_BINARY,
  FRAME_BINARY_END,
  FRAME_JSON,
  FrameDecoder,
  encodeBinary,
  encodeBinaryEnd,
} from '../protocol.js';

// A sessão de arquivos somente leitura que o gerente usa em "Ver pasta" (GOALS 18):
// lista, consulta e baixa; todo o resto é recusado e nenhum link leva para fora.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.decoder = new FrameDecoder();
    this.frames = [];
  }
  write(buffer) {
    this.frames.push(...this.decoder.push(buffer));
    return true;
  }
  pause() {}
  resume() {}
}

let dir;
let root;
let outside;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-agent-'));
  root = path.join(dir, 'ana');
  outside = path.join(dir, 'outro-aluno');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'a.txt'), 'trabalho da Ana');
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'dentro');
  fs.writeFileSync(path.join(outside, 'segredo.txt'), 'de outro aluno');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(options) {
  const socket = new FakeSocket();
  const session = new FileAgentSession(socket, root, options);
  let channel = 0;
  const run = async (msg) => {
    channel += 1;
    socket.frames.length = 0;
    await session.handleFrame({
      type: FRAME_JSON,
      channelId: channel,
      payload: Buffer.from(JSON.stringify(msg)),
    });
    const json = socket.frames
      .filter((frame) => frame.type === FRAME_JSON)
      .map((frame) => JSON.parse(frame.payload.toString('utf8')));
    const data = Buffer.concat(
      socket.frames.filter((frame) => frame.type === FRAME_BINARY).map((frame) => frame.payload),
    );
    return { json, data, channel };
  };
  return { session, socket, run };
}

describe('read-only file session', () => {
  it('lists, stats and downloads', async () => {
    const { run } = open({ readOnly: true });
    const list = await run({ cmd: 'list', path: '/' });
    expect(list.json[0]).toMatchObject({ cmd: 'list_res', ok: true });
    expect(list.json[0].entries.map((entry) => entry.name).sort()).toEqual(['a.txt', 'sub']);
    expect((await run({ cmd: 'list', path: '/sub' })).json[0].entries[0].name).toBe('b.txt');
    expect((await run({ cmd: 'stat', path: '/a.txt' })).json[0]).toMatchObject({
      ok: true,
      dir: false,
      size: 15,
    });
    const get = await run({ cmd: 'get', path: '/a.txt' });
    expect(get.json[0]).toMatchObject({ cmd: 'get_res', ok: true, name: 'a.txt' });
    expect(get.data.toString('utf8')).toBe('trabalho da Ana');
  });

  it('refuses mkdir, put, rename and delete and leaves the disk as it was', async () => {
    const { run } = open({ readOnly: true });
    const before = fs.readdirSync(root).sort();
    for (const msg of [
      { cmd: 'mkdir', path: '/nova' },
      { cmd: 'put', path: '/novo.txt' },
      { cmd: 'put', path: '/a.txt' },
      { cmd: 'rename', path: '/a.txt', newPath: '/b.txt' },
      { cmd: 'delete', path: '/a.txt' },
      { cmd: 'delete', path: '/sub' },
    ]) {
      const answer = await run(msg);
      expect(answer.json[0]).toMatchObject({ ok: false, error: 'Esta pasta é somente leitura' });
    }
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('trabalho da Ana');
    expect(fs.existsSync(path.join(root, 'sub', 'b.txt'))).toBe(true);
  });

  it('writes nothing even when binary upload frames arrive anyway', async () => {
    const { session, run } = open({ readOnly: true });
    const put = await run({ cmd: 'put', path: '/injetado.txt' });
    expect(put.json[0].ok).toBe(false);
    await session.handleFrame({
      type: FRAME_BINARY,
      channelId: put.channel,
      payload: encodeBinary(put.channel, Buffer.from('x')).subarray(9),
    });
    await session.handleFrame({
      type: FRAME_BINARY_END,
      channelId: put.channel,
      payload: encodeBinaryEnd(put.channel).subarray(9),
    });
    expect(fs.existsSync(path.join(root, 'injetado.txt'))).toBe(false);
    expect(session.uploads.size).toBe(0);
    expect(session.filesTransferred).toBe(0);
  });

  it('cannot leave the root with .. or an absolute path', async () => {
    const { run } = open({ readOnly: true });
    for (const target of [
      '/../outro-aluno',
      '/sub/../../outro-aluno/segredo.txt',
      '..\\outro-aluno',
    ]) {
      const answer = await run({ cmd: 'list', path: target });
      expect(answer.json[0]).toMatchObject({ ok: false });
    }
    const absolute = await run({ cmd: 'get', path: path.join(outside, 'segredo.txt') });
    // Um caminho "absoluto" é só mais um caminho relativo à raiz: não existe lá dentro.
    expect(absolute.json[0].ok).toBe(false);
    expect(absolute.data.length).toBe(0);
  });

  it('does not follow a junction that points at another student', async () => {
    try {
      fs.symlinkSync(outside, path.join(root, 'atalho'), 'junction');
    } catch {
      return; // sem permissão para criar o link neste ambiente
    }
    const { run } = open({ readOnly: true });
    expect((await run({ cmd: 'list', path: '/atalho' })).json[0]).toMatchObject({
      ok: false,
      error: 'Caminho fora da raiz permitida',
    });
    const get = await run({ cmd: 'get', path: '/atalho/segredo.txt' });
    expect(get.json[0]).toMatchObject({ ok: false, error: 'Caminho fora da raiz permitida' });
    expect(get.data.length).toBe(0);
  });

  it('still lets a normal session write (nothing changed for the other flows)', async () => {
    const { run } = open();
    expect((await run({ cmd: 'mkdir', path: '/nova' })).json[0]).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(root, 'nova'))).toBe(true);
    expect((await run({ cmd: 'rename', path: '/nova', newPath: '/outra' })).json[0].ok).toBe(true);
    expect((await run({ cmd: 'delete', path: '/outra' })).json[0].ok).toBe(true);
  });
});
