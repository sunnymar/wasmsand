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

  busyboxIt('user can install busybox applet symlinks via `busybox --install -s`', async () => {
    // The sandbox does NOT auto-remap coreutils to busybox multicall: by
    // default `/usr/bin/grep` is the standalone GNU-style coreutils
    // fixture. Consumers that want BusyBox semantics install the
    // symlinks themselves from shell, using BusyBox's own `--install`.
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    // User opts in: install BusyBox applet symlinks into a directory on PATH.
    // Our BusyBox build has CONFIG_FEATURE_INSTALLER=n, so we drive it from
    // shell using `busybox --list` + `ln -s`, which is what any BusyBox
    // distribution bootstrap script does.
    const install = await sandbox.run(
      'mkdir -p /tmp/bb-bin && ' +
      'for a in $(busybox --list); do ln -sf /usr/bin/busybox /tmp/bb-bin/$a; done',
    );
    expect(install.exitCode).toBe(0);

    // After install, `/tmp/bb-bin/grep` is a symlink to `/usr/bin/busybox`
    // so shell lookups in that directory dispatch to the multicall binary.
    const linkResult = await sandbox.run('readlink /tmp/bb-bin/grep');
    expect(linkResult.stdout.trim()).toBe('/usr/bin/busybox');

    // Invoking `grep` via PATH must actually dispatch the BusyBox applet
    // (not the standalone GNU-style coreutil that `/usr/bin/grep` points
    // at by default).  BusyBox's --help banner begins with "BusyBox v...
    // multi-call binary." — GNU grep's help text does not mention BusyBox,
    // so this discriminates which binary actually ran.
    const bbHelp = await sandbox.run('PATH=/tmp/bb-bin:$PATH grep --help 2>&1');
    expect(bbHelp.stdout + bbHelp.stderr).toContain('BusyBox');

    const bbGrep = await sandbox.run('PATH=/tmp/bb-bin:$PATH grep foo /tmp/data.txt');
    expect(bbGrep.exitCode).toBe(0);
    expect(bbGrep.stdout.trim()).toBe('foo');

    // Invoking an applet through the symlink by absolute path also dispatches
    // BusyBox's applet — argv[0] must carry the applet name ("grep"), not
    // the symlink target ("busybox"), or multicall dispatch selects the
    // wrong (default) applet.
    const bbAbsGrep = await sandbox.run('/tmp/bb-bin/grep foo /tmp/data.txt');
    expect(bbAbsGrep.exitCode).toBe(0);
    expect(bbAbsGrep.stdout.trim()).toBe('foo');

    // `busybox <applet>` form works regardless of PATH setup.
    const busyboxResult = await sandbox.run('busybox seq 3');
    expect(busyboxResult.exitCode).toBe(0);
    expect(busyboxResult.stdout).toBe('1\n2\n3\n');
  });
});
