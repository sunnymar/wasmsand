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

  // ──────────────────────────────────────────────────────────────────────
  // setjmp/longjmp — POSIX exception-style control flow over Asyncify.
  //
  // codepod implements setjmp/longjmp on top of binaryen's Asyncify pass:
  // setjmp captures the current Asyncify save-state into env, longjmp
  // triggers an unwind that the runtime rewinds back to setjmp's call
  // site so the import returns the longjmp value.  These cases exercise
  // the full surface — first-call zero return, value preservation across
  // longjmp, the POSIX zero→one promotion, longjmp from a few frames
  // deep, and negative values — to make sure every dimension of the
  // contract is hit.
  // ──────────────────────────────────────────────────────────────────────
  describe('setjmp-canary', () => {
    it('setjmp returns 0 on the first call', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case setjmp_returns_zero');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"setjmp_returns_zero","exit":0,"observed":0}');
    });

    it('longjmp(env, 42) makes setjmp return 42', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case smoke');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"smoke","exit":0,"observed":42}');
    });

    it('longjmp(env, 0) is promoted to 1 (POSIX)', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case longjmp_zero');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"longjmp_zero","exit":0,"observed":1}');
    });

    it('longjmp from N frames deep unwinds intermediate frames', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case longjmp_through_calls');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"longjmp_through_calls","exit":0,"observed":7}');
      // The "middle" frame's post-longjmp diagnostic must NOT appear:
      // longjmp must skip the intermediate frame, not return to it.
      expect(r.stderr).not.toContain('returned from longjmp');
    });

    it('preserves negative longjmp values byte-for-byte', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case longjmp_negative');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"longjmp_negative","exit":0,"observed":-7}');
    });
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
    expect(result.stdout.trim()).toBe('getgroups:1:1000');
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

  it('runs the pthread-canary 4-thread mutex stress test', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // Spawns 4 threads, each increments a shared counter 10000 times
    // under mutex, joins all four, asserts counter == 40000.  On the
    // cooperative-serial backend (no real parallelism on Node) this
    // exercises pthread_create / join / mutex_lock / unlock thunks
    // through the codepod::host_thread_* / host_mutex_* host imports.
    const result = await sandbox.run('pthread-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('pthread:ok');
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

    // A user-created symlink that resolves directly to a multicall
    // binary stub picks up the link's basename as argv[0], which the
    // BusyBox dispatcher uses to select the applet.  /tmp/seq → busybox
    // therefore runs as `seq` — same expected output as a standalone
    // seq.wasm.  (Indirect chains like /tmp/x → /tmp/seq → busybox
    // would carry argv[0]="x" and trip the dispatcher, mirroring
    // Linux behavior — this is documented in the busybox-multicall
    // test below.)
    await sandbox.run('ln -sf /usr/bin/busybox /tmp/seq');
    const result = await sandbox.run('/tmp/seq 1 3');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1\n2\n3');
  });

  const busyboxIt = HAS_BUSYBOX_FIXTURE ? it : it.skip;

  busyboxIt('BusyBox is the default for /usr/bin/<applet> when busybox.wasm ships', async () => {
    // The sandbox auto-installs BusyBox applet symlinks at sandbox-
    // creation time when busybox.wasm is present in wasmDir.  This
    // is equivalent to running `busybox --install -s` once at boot:
    // every applet name in the curated list (declared in
    // packages/c-ports/busybox/manifest.json's `multicall.applets`,
    // shipped to wasmDir as busybox.manifest.json by the port's
    // copy-fixtures step) is symlinked /usr/bin/<applet> →
    // /usr/bin/busybox, and the registry entry for that name is
    // overridden to the busybox.wasm path so the shell dispatches
    // through the multicall binary.
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    // /usr/bin/grep is a symlink to /usr/bin/busybox out of the box.
    const linkResult = await sandbox.run('readlink /usr/bin/grep');
    expect(linkResult.stdout.trim()).toBe('/usr/bin/busybox');

    // Bare `grep` resolves through PATH, follows the symlink, and
    // BusyBox's multicall dispatcher picks the grep applet from
    // argv[0].  BusyBox's --help banner says "BusyBox v..." which
    // discriminates against the standalone GNU-style Rust grep.
    const bbHelp = await sandbox.run('grep --help 2>&1');
    expect(bbHelp.stdout + bbHelp.stderr).toContain('BusyBox');

    // Functional dispatch — produces the expected match output.
    const bbGrep = await sandbox.run('grep foo /tmp/data.txt');
    expect(bbGrep.exitCode).toBe(0);
    expect(bbGrep.stdout.trim()).toBe('foo');

    // Absolute path through the symlink also dispatches.  argv[0]
    // is the basename of the path the user typed ("grep"), and
    // BusyBox routes on that — the symlink resolution to busybox.wasm
    // is what the kernel-side spawn picks, but the dispatcher reads
    // argv[0], not the resolved path.
    const bbAbsGrep = await sandbox.run('/usr/bin/grep foo /tmp/data.txt');
    expect(bbAbsGrep.exitCode).toBe(0);
    expect(bbAbsGrep.stdout.trim()).toBe('foo');

    // Direct `busybox <applet>` form still works regardless of PATH.
    const busyboxResult = await sandbox.run('busybox seq 3');
    expect(busyboxResult.exitCode).toBe(0);
    expect(busyboxResult.stdout).toBe('1\n2\n3\n');
  });
});
