/**
 * Integration tests for streaming pipelines.
 *
 * These tests verify end-to-end pipeline execution through the Sandbox API.
 * The streaming pipeline path uses pipe/spawn_async/waitpid to connect
 * pipeline stages with real pipes and concurrent WASM execution via JSPI.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

describe('Streaming Pipelines', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('simple pipeline: echo | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('multi-stage pipeline: echo | grep | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo "hello world" | grep hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('builtin-only pipeline: echo | echo', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello | echo world');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('world');
  });

  it('pipeline produces correct output on repeated runs', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const r1 = await sandbox.run('echo first | grep first');
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout.trim()).toBe('first');

    const r2 = await sandbox.run('echo second | grep second');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe('second');
  });

  it('external-only pipeline: seq | head runs without hanging', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    // Both seq and head are external commands spawned asynchronously.
    // The pipeline completes without deadlock. Output capture for all-external
    // pipelines requires kernel buffer extraction (future work).
    const result = await sandbox.run('seq 1 5 | head -3');
    expect(result.exitCode).toBe(0);
  });

  it('non-pipeline commands still work (regression)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const echo = await sandbox.run('echo hello');
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout.trim()).toBe('hello');

    const env = await sandbox.run('export FOO=bar && echo $FOO');
    expect(env.stdout.trim()).toBe('bar');
  });

  it('non-pipeline external command works (regression)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('file content'));
    const result = await sandbox.run('cat /tmp/data.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('file content');
  });
});
