import { describe, it, expect } from 'bun:test';
import {
  SAB_SIZE,
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  METADATA_OFFSET,
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
} from '../proxy-protocol.js';

describe('proxy-protocol', () => {
  it('exports correct SAB layout constants', () => {
    expect(STATUS_IDLE).toBe(0);
    expect(STATUS_REQUEST).toBe(1);
    expect(STATUS_RESPONSE).toBe(2);
    expect(STATUS_ERROR).toBe(3);
    expect(METADATA_OFFSET).toBe(12);
    expect(SAB_SIZE).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('encodes and decodes a request with no binary', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { op: 'readFile', path: '/tmp/foo' };
    encodeRequest(sab, meta);
    const decoded = decodeRequest(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(decoded.binary).toBeNull();
  });

  it('encodes and decodes a request with binary data', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { op: 'writeFile', path: '/tmp/bar' };
    const binary = new Uint8Array([1, 2, 3, 4, 5]);
    encodeRequest(sab, meta, binary);
    const decoded = decodeRequest(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(decoded.binary).toEqual(binary);
  });

  it('encodes and decodes a response with no binary', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { ok: true };
    encodeResponse(sab, meta);
    const decoded = decodeResponse(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(decoded.binary).toBeNull();
  });

  it('encodes and decodes a response with binary data', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = {};
    const binary = new TextEncoder().encode('hello world');
    encodeResponse(sab, meta, binary);
    const decoded = decodeResponse(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(new TextDecoder().decode(decoded.binary!)).toBe('hello world');
  });

  it('encodes and decodes an error response', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { error: true, code: 'ENOENT', message: 'no such file' };
    encodeResponse(sab, meta);
    const decoded = decodeResponse(sab);
    expect(decoded.metadata.error).toBe(true);
    expect(decoded.metadata.code).toBe('ENOENT');
  });
});
