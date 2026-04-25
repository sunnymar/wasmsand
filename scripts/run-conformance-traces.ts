#!/usr/bin/env -S deno run -A
/**
 * Guest-compat conformance spec-trace driver.
 *
 * Runs every `<symbol>.spec.toml` case under the codepod sandbox and diffs
 * the canary's JSONL trace against expected exit / stdout / errno.
 *
 * Why the sandbox instead of plain wasmtime: the compat archive is
 * --whole-archive'd into every canary, so every canary wasm imports
 * `codepod::host_dup2` (and system/popen variants carry host_run_command
 * too). Plain wasmtime has no such imports — it cannot instantiate the
 * modules. The orchestrator sandbox supplies those imports by definition
 * and is what real consumers will run against, so it is also the authentic
 * target for conformance.
 *
 * Usage:
 *   deno run -A scripts/run-conformance-traces.ts              # C only
 *   deno run -A scripts/run-conformance-traces.ts --include-rust
 *
 * Prereqs: `make -C packages/guest-compat all copy-fixtures` (C canaries);
 * `make -C packages/guest-compat rust-canaries` (Rust, when --include-rust).
 */

import { resolve } from 'node:path';
import { readFileSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { parse as parseToml } from 'jsr:@std/toml';
import { Sandbox } from '../packages/orchestrator/src/sandbox.js';
import { NodeAdapter } from '../packages/orchestrator/src/platform/node-adapter.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/orchestrator/src/platform/__tests__/fixtures');
const CONFORMANCE = resolve(REPO_ROOT, 'packages/guest-compat/conformance');
const RUST_BUILD = resolve(REPO_ROOT, 'packages/guest-compat/build/rust');

const includeRust = Deno.args.includes('--include-rust');

type Expected = { exit?: number; stdout?: string; errno?: number };
type Case = { name: string; expected: Expected };
type Spec = { symbol: string; canary: string; cases: Case[] };

function loadSpecs(): Spec[] {
  const files = readdirSync(CONFORMANCE)
    .filter(f => f.endsWith('.spec.toml'))
    .sort();
  return files.map(f => {
    const text = readFileSync(resolve(CONFORMANCE, f), 'utf8');
    const raw = parseToml(text) as {
      canary: string;
      case?: Array<{ name: string; expected?: Expected }>;
    };
    return {
      symbol: f.replace(/\.spec\.toml$/, ''),
      canary: raw.canary,
      cases: (raw.case ?? []).map(c => ({
        name: c.name,
        expected: c.expected ?? {},
      })),
    };
  });
}

type TraceDiff = string;

function diff(c: Case, raw: string, processExit: number): TraceDiff[] {
  const lastLine = raw.trimEnd().split('\n').at(-1) ?? '';
  let trace: { case?: string; exit?: number; stdout?: string; errno?: number };
  try {
    trace = JSON.parse(lastLine);
  } catch {
    return [`CaseName { expected: "${c.name}", actual: "<unparseable: ${lastLine}>" }`];
  }
  const out: TraceDiff[] = [];
  if (trace.case !== c.name) {
    out.push(`CaseName { expected: "${c.name}", actual: "${trace.case ?? ''}" }`);
  }
  if (trace.exit !== processExit) {
    out.push(`ProcessTraceExitDisagree { trace: ${trace.exit}, process: ${processExit} }`);
  }
  if (c.expected.exit !== undefined && c.expected.exit !== trace.exit) {
    out.push(`Exit { expected: ${c.expected.exit}, actual: ${trace.exit} }`);
  }
  if (c.expected.stdout !== undefined && c.expected.stdout !== trace.stdout) {
    out.push(`Stdout { expected: ${JSON.stringify(c.expected.stdout)}, actual: ${JSON.stringify(trace.stdout ?? null)} }`);
  }
  if (c.expected.errno !== undefined && c.expected.errno !== trace.errno) {
    out.push(`Errno { expected: ${c.expected.errno}, actual: ${JSON.stringify(trace.errno ?? null)} }`);
  }
  return out;
}

// Rust canaries live under build/rust/; stage copies in the fixtures dir
// under a "rust-" prefix so scanTools picks them up as distinct tools.
// The orchestrator rejects paths outside wasmDir, so we cannot register
// them from a side path. Staging is cheap and deterministic.
const rustStaged: string[] = [];
if (includeRust) {
  for (const f of readdirSync(RUST_BUILD)) {
    if (!f.endsWith('-canary.wasm') || f.endsWith('.pre-opt.wasm')) continue;
    const stagedName = `rust-${f}`;
    const dst = resolve(FIXTURES, stagedName);
    copyFileSync(resolve(RUST_BUILD, f), dst);
    rustStaged.push(dst);
  }
}

let exitCode = 0;
try {
  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
  });

  try {
    const specs = loadSpecs();
    let failures = 0;
    let total = 0;
    for (const spec of specs) {
      for (const c of spec.cases) {
        const langs: Array<{ tag: 'c' | 'rust'; tool: string }> = [
          { tag: 'c', tool: spec.canary },
        ];
        if (includeRust) {
          langs.push({ tag: 'rust', tool: `rust-${spec.canary}` });
        }
        for (const { tag, tool } of langs) {
          total++;
          const res = await sandbox.run(`${tool} --case ${c.name}`);
          const diffs = diff(c, res.stdout, res.exitCode);
          if (diffs.length) {
            failures++;
            console.error(`FAIL [${tag}] ${spec.symbol}::${c.name}`);
            for (const d of diffs) console.error(`  - ${d}`);
            console.error(`  raw stdout: ${res.stdout.trimEnd()}`);
          }
        }
      }
    }

    if (failures > 0) {
      console.error(`${failures} of ${total} spec/trace diffs failed`);
      exitCode = 1;
    } else {
      console.log(`conformance: spec/trace diffs OK (${total} cases)`);
    }
  } finally {
    sandbox.destroy();
  }
} finally {
  for (const path of rustStaged) {
    try { unlinkSync(path); } catch { /* best-effort cleanup */ }
  }
}

Deno.exit(exitCode);
