/**
 * End-to-end checks for the Phase A C canaries shipped by the codepod
 * guest compatibility runtime.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const HAS_BUSYBOX_FIXTURE = existsSync(resolve(FIXTURES, 'busybox.wasm'));

describe('Guest compatibility canaries', () => {
  let sandbox: Sandbox | null = null;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = null;
  });

  it('runs stdio-canary as a normal command', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello canary\n'));

    const result = await sandbox.run('stdio-canary /tmp/in.txt /tmp/out.txt');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('stdio-ok');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/out.txt'))).toBe('hello canary\n');
  });

  it('runs sleep-canary and prints the sleep duration', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const requestedMs = 20;
    const lowerBoundMs = 10;
    const started = performance.now();
    const result = await sandbox.run(`sleep-canary ${requestedMs}`);
    const elapsedMs = performance.now() - started;

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`slept:${requestedMs}`);
    expect(elapsedMs).toBeGreaterThanOrEqual(lowerBoundMs);
  });

  it('runs system-canary through the host command shim', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('system-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('system-ok');
  });

  it('runs popen-canary and captures command output', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('popen-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('popen:hello-from-shell');
  });

  it('retries host_run_command when the response exceeds the initial buffer', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('system-canary large');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('system-large-ok');
  });

  it('returns the command exit status from codepod_pclose', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('popen-canary status');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('pclose:7');
  });

  it('reports a single visible CPU through the affinity compat layer', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('affinity-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('affinity:get=1,set0=0,set1=einval');
  });

  it('routes stderr through stdout after dup2(1, 2)', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('dup2-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('dup2-ok');
    expect(result.stderr).toBe('');
  });

  it('exposes the narrow getgroups compatibility contract', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('getgroups-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('getgroups:1:0');
  });

  it('exposes the narrow signal compatibility header surface', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('signal-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('signal-ok');
  });

  it('spawns a tool via absolute path to its /usr/bin stub', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // Invoking /usr/bin/seq directly (absolute path, not bare name) must work.
    // Before the Gap-1 fix, exec_path would try to execute the S_TOOL stub
    // content as a shell script and return exit code 127.
    const result = await sandbox.run('/usr/bin/seq 1 3');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1\n2\n3');
  });

  it('spawns a tool via a VFS symlink to a tool stub', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // Create a VFS symlink /tmp/myseq → /usr/bin/seq (a tool stub).
    // Running /tmp/myseq must dispatch the seq WASM, not try to execute
    // the stub content as a shell script.
    await sandbox.run('ln -sf /usr/bin/seq /tmp/myseq');
    const result = await sandbox.run('/tmp/myseq 1 3');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1\n2\n3');
  });

  const busyboxIt = HAS_BUSYBOX_FIXTURE ? it : it.skip;

  busyboxIt('registers busybox applets as symlinked commands', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    const linkResult = await sandbox.run('readlink /usr/bin/grep');
    const aliasResult = await sandbox.run('grep foo /tmp/data.txt');
    const busyboxResult = await sandbox.run('busybox seq 3');

    expect(linkResult.exitCode).toBe(0);
    expect(linkResult.stdout.trim()).toBe('/usr/bin/busybox');
    expect(aliasResult.exitCode).toBe(0);
    expect(aliasResult.stdout.trim()).toBe('foo');
    expect(busyboxResult.exitCode).toBe(0);
    expect(busyboxResult.stdout).toBe('1\n2\n3\n');
  });
});
