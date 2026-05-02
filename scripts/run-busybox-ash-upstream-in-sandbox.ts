#!/usr/bin/env -S deno run -A

import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Sandbox } from '../packages/kernel/src/sandbox.js';
import { NodeAdapter } from '../packages/kernel/src/platform/node-adapter.js';
import { bashBootImports } from '../packages/sdk-server/src/bash-host-imports.ts';
import { makeRunCommandHandler } from '../packages/sdk-server/src/bash-dispatch.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/kernel/src/platform/__tests__/fixtures');
const BUSYBOX_DIR = resolve(REPO_ROOT, 'packages/c-ports/busybox');
const ASH_TEST_DIR = resolve(BUSYBOX_DIR, 'src-shell/shell/ash_test');
const SHELL_WASM = resolve(BUSYBOX_DIR, 'build-shell/busybox-shell.wasm');
const SHELL_MANIFEST = resolve(BUSYBOX_DIR, 'busybox-shell.manifest.json');
const WORK_WASM_DIR = resolve(BUSYBOX_DIR, 'build/ash-upstream-wasm-dir');
const HELPER_DIR = resolve(BUSYBOX_DIR, 'build-shell/ash-test-helpers');
const RESULTS_JSON = resolve(BUSYBOX_DIR, 'build/test-results/ash-upstream.json');
const CPCC = resolve(REPO_ROOT, 'target/release/cpcc');

const categories = Deno.args.length > 0 ? Deno.args : ['ash-arith'];
const helperNames = ['recho', 'zecho', 'printenv'];

interface UpstreamCase {
  category: string;
  test: string;
  expected: string;
}

interface UpstreamResult {
  category: string;
  test: string;
  stdout: string;
  expected: string;
  exitCode: number;
  pass: boolean;
  skip: boolean;
}

function ensureBuilt(): void {
  if (Deno.env.get('CODEPOD_BUSYBOX_ASH_SKIP_BUILD') === '1') return;
  execFileSync('make', ['-C', 'packages/c-ports/busybox', 'shell'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function buildHelpers(): void {
  mkdirSync(HELPER_DIR, { recursive: true });
  for (const name of helperNames) {
    execFileSync(CPCC, [
      '-std=gnu89',
      '-O2',
      '-o',
      resolve(HELPER_DIR, `${name}.wasm`),
      resolve(ASH_TEST_DIR, `${name}.c`),
    ], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }
}

function prepareWasmDir(): void {
  rmSync(WORK_WASM_DIR, { recursive: true, force: true });
  mkdirSync(WORK_WASM_DIR, { recursive: true });
  cpSync(FIXTURES, WORK_WASM_DIR, { recursive: true });
  copyFileSync(SHELL_WASM, resolve(WORK_WASM_DIR, 'busybox-shell.wasm'));
  copyFileSync(SHELL_MANIFEST, resolve(WORK_WASM_DIR, 'busybox-shell.manifest.json'));
}

function mkdirp(sandbox: Sandbox, path: string): void {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      sandbox.mkdir(current);
    } catch {
      // Existing directories are fine.
    }
  }
}

function uploadDir(sandbox: Sandbox, hostPath: string, sandboxPath: string): void {
  mkdirp(sandbox, sandboxPath);
  for (const entry of Deno.readDirSync(hostPath)) {
    const childHostPath = resolve(hostPath, entry.name);
    const childSandboxPath = `${sandboxPath.replace(/\/$/, '')}/${entry.name}`;
    if (entry.isDirectory) {
      uploadDir(sandbox, childHostPath, childSandboxPath);
    } else if (entry.isFile) {
      sandbox.writeFile(childSandboxPath, Deno.readFileSync(childHostPath));
    }
  }
}

function collectCases(): UpstreamCase[] {
  const cases: UpstreamCase[] = [];
  for (const category of categories) {
    const hostCategoryDir = resolve(ASH_TEST_DIR, category);
    const tests = [...Deno.readDirSync(hostCategoryDir)]
      .filter((entry) => entry.isFile && entry.name.endsWith('.tests'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const test of tests) {
      const right = test.replace(/\.tests$/, '.right');
      const rightPath = resolve(hostCategoryDir, right);
      try {
        const expected = Deno.readTextFileSync(rightPath);
        cases.push({ category, test, expected });
      } catch {
        // Upstream run-all skips tests without a matching .right baseline.
      }
    }
  }
  return cases;
}

async function runCase(sandbox: Sandbox, testCase: UpstreamCase): Promise<UpstreamResult> {
  const proc = await sandbox.spawn([
    '/bin/sh',
    '-c',
    `cd /tmp/ash_test/${testCase.category} && PATH=/tmp/bin:/bin:/usr/bin THIS_SH=/bin/sh /bin/sh ./${testCase.test} 2>&1`,
  ]);
  const stdout = proc.fdReadAndClear(1).data;
  const exitCode = proc.exitCode ?? 0;
  const skip = exitCode === 77;
  return {
    ...testCase,
    stdout,
    exitCode,
    pass: !skip && stdout === testCase.expected,
    skip,
  };
}

ensureBuilt();
buildHelpers();
prepareWasmDir();
mkdirSync(dirname(RESULTS_JSON), { recursive: true });

const sandbox = await Sandbox.create({
  wasmDir: WORK_WASM_DIR,
  bootWasmPath: resolve(WORK_WASM_DIR, 'codepod-shell-exec.wasm'),
  adapter: new NodeAdapter(),
  bootImports: bashBootImports,
  runCommandHandler: makeRunCommandHandler(),
  timeoutMs: 30_000,
});

const results: UpstreamResult[] = [];
try {
  uploadDir(sandbox, ASH_TEST_DIR, '/tmp/ash_test');
  mkdirp(sandbox, '/tmp/bin');
  for (const name of helperNames) {
    sandbox.writeFile(`/tmp/bin/${name}`, Deno.readFileSync(resolve(HELPER_DIR, `${name}.wasm`)));
  }

  for (const testCase of collectCases()) {
    const result = await runCase(sandbox, testCase);
    results.push(result);
    const status = result.skip ? 'SKIP' : result.pass ? 'PASS' : 'FAIL';
    console.log(`[busybox-ash-upstream] ${status} ${testCase.category}/${testCase.test}`);
    if (!result.pass && !result.skip) {
      console.log(`  exit: ${result.exitCode}`);
      console.log(`  actual prefix:   ${JSON.stringify(result.stdout.slice(0, 400))}`);
      console.log(`  expected prefix: ${JSON.stringify(result.expected.slice(0, 400))}`);
    }
  }
} finally {
  sandbox.destroy();
}

const summary = {
  categories,
  total: results.length,
  passed: results.filter((result) => result.pass).length,
  skipped: results.filter((result) => result.skip).length,
  failed: results.filter((result) => !result.pass && !result.skip).length,
  results,
};

writeFileSync(RESULTS_JSON, JSON.stringify(summary, null, 2) + '\n');

if (summary.failed > 0) {
  console.error(`[busybox-ash-upstream] FAIL: ${summary.failed}/${summary.total} test(s) failed`);
  Deno.exit(1);
}

console.log(`[busybox-ash-upstream] OK: ${summary.passed}/${summary.total} tests passed`);
console.log(`[busybox-ash-upstream] results: ${RESULTS_JSON}`);
