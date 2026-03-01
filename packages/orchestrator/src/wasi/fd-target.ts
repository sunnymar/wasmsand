import type { AsyncPipeReadEnd, AsyncPipeWriteEnd } from '../vfs/pipe.js';

/** Target for a file descriptor in a process's fd table. */
export type FdTarget =
  | { type: 'buffer'; buf: Uint8Array[]; total: number; limit: number; truncated: boolean }
  | { type: 'pipe_read'; pipe: AsyncPipeReadEnd }
  | { type: 'pipe_write'; pipe: AsyncPipeWriteEnd }
  | { type: 'static'; data: Uint8Array; offset: number }
  | { type: 'null' };

export function createBufferTarget(limit = Infinity): FdTarget & { type: 'buffer' } {
  return { type: 'buffer', buf: [], total: 0, limit, truncated: false };
}

export function createStaticTarget(data: Uint8Array): FdTarget & { type: 'static' } {
  return { type: 'static', data, offset: 0 };
}

export function createNullTarget(): FdTarget & { type: 'null' } {
  return { type: 'null' };
}

/** Concatenate buffer target chunks into a string. */
export function bufferToString(target: FdTarget & { type: 'buffer' }): string {
  const total = target.buf.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of target.buf) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
