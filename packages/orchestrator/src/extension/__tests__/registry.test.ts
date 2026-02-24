import { describe, it, expect } from 'bun:test';
import { ExtensionRegistry } from '../registry.js';
import type { ExtensionConfig, ExtensionInvokeArgs } from '../types.js';

function makeHandler(stdout: string) {
  return async (_input: ExtensionInvokeArgs) => ({ stdout, exitCode: 0 });
}

describe('ExtensionRegistry', () => {
  it('registers and retrieves an extension', () => {
    const reg = new ExtensionRegistry();
    const ext: ExtensionConfig = { name: 'hello', command: makeHandler('hi') };
    reg.register(ext);
    expect(reg.has('hello')).toBe(true);
    expect(reg.get('hello')).toBe(ext);
  });

  it('returns undefined for unknown extension', () => {
    const reg = new ExtensionRegistry();
    expect(reg.has('nope')).toBe(false);
    expect(reg.get('nope')).toBeUndefined();
  });

  it('lists all registered extensions', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'a', command: makeHandler('a') });
    reg.register({ name: 'b', pythonPackage: { version: '1.0', files: {} } });
    expect(reg.list()).toHaveLength(2);
  });

  it('getCommandNames returns only extensions with command', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'cmd', command: makeHandler('x') });
    reg.register({ name: 'pkg', pythonPackage: { version: '1.0', files: {} } });
    expect(reg.getCommandNames()).toEqual(['cmd']);
  });

  it('getPackageNames returns only extensions with pythonPackage', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'cmd', command: makeHandler('x') });
    reg.register({ name: 'pkg', pythonPackage: { version: '1.0', files: {} } });
    expect(reg.getPackageNames()).toEqual(['pkg']);
  });

  it('invokes a command handler', async () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'greet', command: makeHandler('hello world') });
    const result = await reg.invoke('greet', {
      args: [], stdin: '', env: {}, cwd: '/',
    });
    expect(result.stdout).toBe('hello world');
    expect(result.exitCode).toBe(0);
  });

  it('invoke passes args and stdin to handler', async () => {
    const reg = new ExtensionRegistry();
    reg.register({
      name: 'echo',
      command: async (input) => ({
        stdout: `args=${input.args.join(',')} stdin=${input.stdin}`,
        exitCode: 0,
      }),
    });
    const result = await reg.invoke('echo', {
      args: ['--flag', 'val'], stdin: 'data', env: {}, cwd: '/',
    });
    expect(result.stdout).toBe('args=--flag,val stdin=data');
  });

  it('invoke throws on unknown extension', async () => {
    const reg = new ExtensionRegistry();
    await expect(reg.invoke('nope', {
      args: [], stdin: '', env: {}, cwd: '/',
    })).rejects.toThrow('Extension "nope" not found');
  });

  it('invoke throws on extension without command handler', async () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'pkg', pythonPackage: { version: '1.0', files: {} } });
    await expect(reg.invoke('pkg', {
      args: [], stdin: '', env: {}, cwd: '/',
    })).rejects.toThrow('Extension "pkg" not found or has no command handler');
  });
});
