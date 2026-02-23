import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Dispatcher } from './dispatcher.js';
import type { SandboxLike } from './dispatcher.js';

function createMockSandbox(): SandboxLike {
  return {
    run: mock(async (_cmd: string) => ({
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      executionTimeMs: 5,
    })),
    readFile: mock((_path: string) => new TextEncoder().encode('file content')),
    writeFile: mock((_path: string, _data: Uint8Array) => {}),
    readDir: mock((_path: string) => [
      { name: 'a.txt', type: 'file' as const },
      { name: 'sub', type: 'dir' as const },
    ]),
    mkdir: mock((_path: string) => {}),
    stat: mock((path: string) => ({
      type: 'file' as const,
      size: 12,
      permissions: 0o644,
      mtime: new Date('2025-01-01'),
      ctime: new Date('2025-01-01'),
      atime: new Date('2025-01-01'),
    })),
    rm: mock((_path: string) => {}),
    setEnv: mock((_name: string, _value: string) => {}),
    getEnv: mock((name: string) => (name === 'FOO' ? 'bar' : undefined)),
    destroy: mock(() => {}),
    snapshot: mock(() => '1'),
    restore: mock((_id: string) => {}),
    fork: mock(async () => createMockSandbox()),
  };
}

describe('Dispatcher', () => {
  let sandbox: ReturnType<typeof createMockSandbox>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    sandbox = createMockSandbox();
    dispatcher = new Dispatcher(sandbox);
  });

  describe('run', () => {
    it('calls sandbox.run() and returns the result', async () => {
      const result = await dispatcher.dispatch('run', { command: 'echo hello' });
      expect(sandbox.run).toHaveBeenCalledWith('echo hello');
      expect(result).toEqual({
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        executionTimeMs: 5,
      });
    });

    it('rejects when command param is missing', async () => {
      await expect(dispatcher.dispatch('run', {})).rejects.toMatchObject({
        code: -32602,
      });
    });

    it('rejects command exceeding 64KB', async () => {
      const huge = 'echo ' + 'x'.repeat(70_000);
      await expect(dispatcher.dispatch('run', { command: huge })).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('too large'),
      });
    });
  });

  describe('files.write', () => {
    it('decodes base64 data and calls sandbox.writeFile()', async () => {
      const data = Buffer.from('hello world').toString('base64');
      const result = await dispatcher.dispatch('files.write', {
        path: '/tmp/test.txt',
        data,
      });
      expect(sandbox.writeFile).toHaveBeenCalledWith(
        '/tmp/test.txt',
        expect.any(Uint8Array),
      );
      // Verify the decoded content
      const written = (sandbox.writeFile as ReturnType<typeof mock>).mock.calls[0][1] as Uint8Array;
      expect(new TextDecoder().decode(written)).toBe('hello world');
      expect(result).toEqual({ ok: true });
    });

    it('rejects when path param is missing', async () => {
      await expect(
        dispatcher.dispatch('files.write', { data: 'aGVsbG8=' }),
      ).rejects.toMatchObject({ code: -32602 });
    });

    it('rejects when data param is missing', async () => {
      await expect(
        dispatcher.dispatch('files.write', { path: '/tmp/test.txt' }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });

  describe('files.read', () => {
    it('calls sandbox.readFile() and encodes to base64', async () => {
      const result = await dispatcher.dispatch('files.read', { path: '/tmp/test.txt' });
      expect(sandbox.readFile).toHaveBeenCalledWith('/tmp/test.txt');
      expect(result).toEqual({
        data: Buffer.from('file content').toString('base64'),
      });
    });

    it('rejects when path param is missing', async () => {
      await expect(dispatcher.dispatch('files.read', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('files.list', () => {
    it('calls sandbox.readDir() and enriches with size via stat()', async () => {
      const result = await dispatcher.dispatch('files.list', { path: '/tmp' });
      expect(sandbox.readDir).toHaveBeenCalledWith('/tmp');
      // stat should be called for each entry
      expect(sandbox.stat).toHaveBeenCalledWith('/tmp/a.txt');
      expect(sandbox.stat).toHaveBeenCalledWith('/tmp/sub');
      expect(result).toEqual({
        entries: [
          { name: 'a.txt', type: 'file', size: 12 },
          { name: 'sub', type: 'dir', size: 12 },
        ],
      });
    });

    it('rejects when path param is missing', async () => {
      await expect(dispatcher.dispatch('files.list', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('files.mkdir', () => {
    it('calls sandbox.mkdir() and returns ok', async () => {
      const result = await dispatcher.dispatch('files.mkdir', { path: '/tmp/newdir' });
      expect(sandbox.mkdir).toHaveBeenCalledWith('/tmp/newdir');
      expect(result).toEqual({ ok: true });
    });

    it('rejects when path param is missing', async () => {
      await expect(dispatcher.dispatch('files.mkdir', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('files.rm', () => {
    it('calls sandbox.rm() and returns ok', async () => {
      const result = await dispatcher.dispatch('files.rm', { path: '/tmp/test.txt' });
      expect(sandbox.rm).toHaveBeenCalledWith('/tmp/test.txt');
      expect(result).toEqual({ ok: true });
    });

    it('rejects when path param is missing', async () => {
      await expect(dispatcher.dispatch('files.rm', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('files.stat', () => {
    it('calls sandbox.stat() and returns name/type/size', async () => {
      const result = await dispatcher.dispatch('files.stat', { path: '/tmp/test.txt' });
      expect(sandbox.stat).toHaveBeenCalledWith('/tmp/test.txt');
      expect(result).toEqual({
        name: 'test.txt',
        type: 'file',
        size: 12,
      });
    });

    it('extracts basename from a nested path', async () => {
      const result = await dispatcher.dispatch('files.stat', {
        path: '/a/b/c/deep.js',
      });
      expect(result).toEqual({
        name: 'deep.js',
        type: 'file',
        size: 12,
      });
    });

    it('rejects when path param is missing', async () => {
      await expect(dispatcher.dispatch('files.stat', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('env.set', () => {
    it('calls sandbox.setEnv() and returns ok', async () => {
      const result = await dispatcher.dispatch('env.set', {
        name: 'MY_VAR',
        value: 'my_value',
      });
      expect(sandbox.setEnv).toHaveBeenCalledWith('MY_VAR', 'my_value');
      expect(result).toEqual({ ok: true });
    });

    it('rejects when name param is missing', async () => {
      await expect(
        dispatcher.dispatch('env.set', { value: 'v' }),
      ).rejects.toMatchObject({ code: -32602 });
    });

    it('rejects when value param is missing', async () => {
      await expect(
        dispatcher.dispatch('env.set', { name: 'X' }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });

  describe('env.get', () => {
    it('calls sandbox.getEnv() and returns the value', async () => {
      const result = await dispatcher.dispatch('env.get', { name: 'FOO' });
      expect(sandbox.getEnv).toHaveBeenCalledWith('FOO');
      expect(result).toEqual({ value: 'bar' });
    });

    it('returns null when the variable is unset', async () => {
      const result = await dispatcher.dispatch('env.get', { name: 'MISSING' });
      expect(sandbox.getEnv).toHaveBeenCalledWith('MISSING');
      expect(result).toEqual({ value: null });
    });

    it('rejects when name param is missing', async () => {
      await expect(dispatcher.dispatch('env.get', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('kill', () => {
    it('calls sandbox.destroy() and returns ok', async () => {
      expect(dispatcher.isKilled()).toBe(false);
      const result = await dispatcher.dispatch('kill', {});
      expect(sandbox.destroy).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
      expect(dispatcher.isKilled()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('rejects with code -32601 for unknown method', async () => {
      await expect(
        dispatcher.dispatch('nonexistent.method', {}),
      ).rejects.toMatchObject({
        code: -32601,
        message: 'Method not found: nonexistent.method',
      });
    });

    it('wraps sandbox errors with code 1', async () => {
      // Simulate a VfsError-like error
      const err = new Error('ENOENT: file not found: /missing.txt');
      (sandbox.readFile as ReturnType<typeof mock>).mockImplementation(() => {
        throw err;
      });

      await expect(
        dispatcher.dispatch('files.read', { path: '/missing.txt' }),
      ).rejects.toMatchObject({
        code: 1,
        message: 'ENOENT: file not found: /missing.txt',
      });
    });

    it('wraps sandbox errors from async methods with code 1', async () => {
      (sandbox.run as ReturnType<typeof mock>).mockRejectedValue(
        new Error('something went wrong'),
      );

      await expect(
        dispatcher.dispatch('run', { command: 'bad' }),
      ).rejects.toMatchObject({
        code: 1,
        message: 'something went wrong',
      });
    });
  });

  describe('snapshot.create', () => {
    it('calls sandbox.snapshot() and returns id', async () => {
      const result = await dispatcher.dispatch('snapshot.create', {});
      expect(sandbox.snapshot).toHaveBeenCalled();
      expect(result).toEqual({ id: '1' });
    });
  });

  describe('snapshot.restore', () => {
    it('calls sandbox.restore() with id', async () => {
      const result = await dispatcher.dispatch('snapshot.restore', { id: '1' });
      expect(sandbox.restore).toHaveBeenCalledWith('1');
      expect(result).toEqual({ ok: true });
    });

    it('rejects when id param is missing', async () => {
      await expect(dispatcher.dispatch('snapshot.restore', {})).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  describe('sandbox.fork', () => {
    it('calls sandbox.fork() and returns sandboxId', async () => {
      const result = await dispatcher.dispatch('sandbox.fork', {});
      expect(sandbox.fork).toHaveBeenCalled();
      expect(result).toHaveProperty('sandboxId');
    });
  });
});
