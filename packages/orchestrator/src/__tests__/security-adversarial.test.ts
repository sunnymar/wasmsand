/**
 * Adversarial security tests.
 *
 * These tests validate that the sandbox's defense-in-depth measures hold up
 * against deliberately crafted adversarial inputs. They complement the
 * acceptance tests in security.test.ts by probing edge cases and bypass
 * attempts.
 */
import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/codepod-shell.wasm');

describe('Security: adversarial inputs', () => {

  it('extension blocked by allowlist cannot be reached via pipe', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo'] },
      extensions: [{
        name: 'secret',
        command: async () => ({ stdout: 'leaked\n', exitCode: 0 }),
      }],
    });
    const result = await sb.run('echo test | secret');
    expect(result.stdout).not.toContain('leaked');
    sb.destroy();
  });

  it('blocked tool cannot be reached via command substitution', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo'] },
    });
    // When grep is blocked inside $(), it produces no stdout, so the
    // substitution yields ''. The critical property: no data is leaked.
    const result = await sb.run('echo $(grep test /etc/passwd)');
    // The grep must not produce any useful output in the substitution
    expect(result.stdout.trim()).toBe('');
    // Also verify the blocked tool directly
    const direct = await sb.run('grep test /etc/passwd');
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr).toContain('not allowed');
    sb.destroy();
  });

  it('script file cannot run blocked commands', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo', 'cat'] },
    });
    sb.writeFile('/tmp/evil.sh', new TextEncoder().encode('#!/bin/sh\ngrep secret /etc/passwd\n'));
    const result = await sb.run('source /tmp/evil.sh');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not allowed');
    sb.destroy();
  });

  it('deeply nested command substitution is bounded', async () => {
    // Build a command with 60 levels of nesting, exceeding MAX_SUBSTITUTION_DEPTH (50).
    // When the depth limit is hit, inner substitutions return '' silently,
    // so 'innermost' should never appear in the output.
    let cmd = 'echo innermost';
    for (let i = 0; i < 60; i++) cmd = `echo $(${cmd})`;
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    const result = await sb.run(cmd);
    // The innermost value should be swallowed by the depth limit
    expect(result.stdout).not.toContain('innermost');
    sb.destroy();
  });

  it('output truncation works under repeated writes', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { limits: { stdoutBytes: 1024 } },
    });
    // Generate a single command whose output far exceeds the 1024-byte limit
    const result = await sb.run('seq 1 5000');
    // Allow for truncation marker overhead; output should be bounded
    expect(result.stdout.length).toBeLessThan(2048);
    sb.destroy();
  });

  it('very long command is rejected', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { limits: { commandBytes: 100 } },
    });
    const result = await sb.run('echo ' + 'a'.repeat(200));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorClass).toBe('LIMIT_EXCEEDED');
    sb.destroy();
  });

  it('symlink chains are bounded', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    // Create a circular symlink chain: link1 -> link2 -> link1
    const result = await sb.run('ln -s /tmp/link1 /tmp/link2; ln -s /tmp/link2 /tmp/link1; cat /tmp/link1');
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it('path traversal via .. is neutralized', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    // Try to escape writable directories.
    // The VFS normalizes paths: /tmp/../../../etc/passwd becomes /etc/passwd
    // which is outside the writable paths ['/home/user', '/tmp'], so EROFS.
    const result = await sb.run('echo evil > /tmp/../../../etc/passwd');
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it('fork inherits allowlist restrictions', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo'] },
    });
    const forked = await sb.fork();
    const result = await forked.run('grep test /tmp/a');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not allowed');
    forked.destroy();
    sb.destroy();
  });
});
