'use strict';

// Frame binário multiplexado: [type:1][channelId:4 BE][length:4 BE][payload]
// channelId identifica a operação (list/stat/get/put/...) e permite que
// múltiplas transferências concorram no mesmo socket TCP sem se misturar.
const HEADER_SIZE = 9;

const FRAME_JSON = 0x01;
const FRAME_BINARY = 0x02;
const FRAME_BINARY_END = 0x03;

function encodeFrame(type, channelId, payload) {
  const body = payload || Buffer.alloc(0);
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(channelId >>> 0, 1);
  header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

function encodeJson(channelId, obj) {
  return encodeFrame(FRAME_JSON, channelId, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function encodeBinary(channelId, chunk) {
  return encodeFrame(FRAME_BINARY, channelId, chunk);
}

function encodeBinaryEnd(channelId) {
  return encodeFrame(FRAME_BINARY_END, channelId, Buffer.alloc(0));
}

// Decodificador incremental: recebe Buffers arbitrários (chegam picotados
// pelo TCP) e devolve frames completos assim que possível.
class FrameDecoder {
  constructor() {
    this._chunks = [];
    this._chunksLength = 0;
    this._needed = HEADER_SIZE;
    this._header = null;
  }

  push(buf) {
    this._chunks.push(buf);
    this._chunksLength += buf.length;
    const frames = [];

    for (;;) {
      if (this._chunksLength < this._needed) break;
      const merged = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._chunksLength);

      if (!this._header) {
        const type = merged.readUInt8(0);
        const channelId = merged.readUInt32BE(1);
        const length = merged.readUInt32BE(5);
        this._header = { type, channelId, length };
        this._needed = HEADER_SIZE + length;
        this._chunks = [merged];
        this._chunksLength = merged.length;
        if (this._chunksLength < this._needed) break;
        continue;
      }

      const { type, channelId, length } = this._header;
      const payload = Buffer.from(merged.subarray(HEADER_SIZE, HEADER_SIZE + length));
      const rest = merged.subarray(HEADER_SIZE + length);
      frames.push({ type, channelId, payload });
      this._header = null;
      this._needed = HEADER_SIZE;
      this._chunks = rest.length ? [rest] : [];
      this._chunksLength = rest.length;
    }

    return frames;
  }
}

module.exports = {
  HEADER_SIZE,
  FRAME_JSON,
  FRAME_BINARY,
  FRAME_BINARY_END,
  encodeFrame,
  encodeJson,
  encodeBinary,
  encodeBinaryEnd,
  FrameDecoder,
};
