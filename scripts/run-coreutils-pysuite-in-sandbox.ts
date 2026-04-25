#!/usr/bin/env -S deno run -A
/**
 * Run packages/coreutils/tests/test_coreutils.py inside codepod sandboxes.
 *
 * Strategy: Run each register_*_tests() section in a separate Deno subprocess.
 * This gives us:
 *  - True OS-level kill on timeout (via AbortController)
 *  - Complete WASM heap reclamation between sections (separate process)
 *  - Isolation: one hung/crashing section can't affect others
 *
 * The helper script run-coreutils-section.ts handles the per-section logic.
 * test_coreutils.py is uploaded unmodified to each sandbox.
 *
 * Steps:
 *  1. Ensure coreutils wasms are built.
 *  2. For each section: spawn a Deno subprocess that runs one sandbox.
 *  3. Parse PASS/FAIL/SKIP output from each subprocess.
 *  4. Aggregate results, classify failures, write findings doc.
 *  5. Exit 0/1 per tolerance policy.
 */

import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/orchestrator/src/platform/__tests__/fixtures');
const SECTION_RUNNER = resolve(import.meta.dirname, 'run-coreutils-section.ts');
const FINDINGS_DIR = resolve(REPO_ROOT, 'docs/superpowers/findings');
const FINDINGS_FILE = resolve(FINDINGS_DIR, '2026-04-22-coreutils-pysuite-on-codepod.md');

// Any upstream test failure makes CI fail. The runner's job is to report
// numbers; it is not the runner's job to decide what's "acceptable."
// Known-open failures get tracked in the findings doc + ledger, not hidden
// behind a tolerance knob that lets CI go green on red suites.
const TOLERANCE = 0;

// All sections in order (matches main() in test_coreutils.py)
const SECTIONS: string[] = [
  'register_echo_tests',
  'register_basename_tests',
  'register_seq_tests',
  'register_wc_tests',
  'register_cut_tests',
  'register_head_tests',
  'register_tail_tests',
  'register_sort_tests',
  'register_uniq_tests',
  'register_base64_tests',
  'register_fold_tests',
  'register_paste_tests',
  'register_tr_tests',
  'register_dirname_tests',
  'register_basename_edge_tests',
  'register_seq_extra_tests',
  'register_sort_extra_tests',
  'register_head_tail_extra_tests',
  'register_wc_extra_tests',
  'register_cut_extra_tests',
  'register_tr_extra_tests',
  'register_base64_extra_tests',
  'register_uniq_extra_tests',
  'register_fold_extra_tests',
  'register_paste_extra_tests',
];

// ---------------------------------------------------------------------------
// Step 1: ensure coreutils wasms are available
// ---------------------------------------------------------------------------

const SENTINEL_TOOLS = ['echo', 'sort', 'wc', 'tr', 'cut'];
const missingTools = SENTINEL_TOOLS.filter(t => !existsSync(resolve(FIXTURES, `${t}.wasm`)));
if (missingTools.length > 2) {
  console.log('[coreutils-pysuite] coreutils wasms missing, running build-coreutils.sh...');
  execSync('./scripts/build-coreutils.sh --engine=cargo-codepod --copy-fixtures', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

// ---------------------------------------------------------------------------
// Parse result lines from a section run
// ---------------------------------------------------------------------------

interface ParsedTest {
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIP';
  name: string;
  message: string;
}

function parseOutput(output: string): ParsedTest[] {
  const results: ParsedTest[] = [];
  for (const line of output.split('\n')) {
    const passMatch = line.match(/^\s+PASS\s+(.+)$/);
    const failMatch = line.match(/^\s+FAIL\s+(.+?):\s*(.*)$/);
    const errorMatch = line.match(/^\s+ERROR\s+(.+?):\s*(.*)$/);
    const skipMatch = line.match(/^\s+SKIP\s+(.+?)(?::\s*(.*))?$/);
    if (passMatch) {
      results.push({ status: 'PASS', name: passMatch[1].trim(), message: '' });
    } else if (failMatch) {
      results.push({ status: 'FAIL', name: failMatch[1].trim(), message: failMatch[2].trim() });
    } else if (errorMatch) {
      results.push({ status: 'ERROR', name: errorMatch[1].trim(), message: errorMatch[2].trim() });
    } else if (skipMatch) {
      results.push({ status: 'SKIP', name: skipMatch[1].trim(), message: (skipMatch[2] || '').trim() });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Run one section in a fresh subprocess
// ---------------------------------------------------------------------------

interface SectionResult {
  section: string;
  tests: ParsedTest[];
  output: string;
  timedOut: boolean;
  elapsedMs: number;
}

const SECTION_TIMEOUT_MS = 90_000; // 90s per section

async function runSection(section: string): Promise<SectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SECTION_TIMEOUT_MS);
  const start = Date.now();

  // Find deno binary
  const denoBin = Deno.execPath();

  try {
    const cmd = new Deno.Command(denoBin, {
      args: [
        'run',
        '-A',
        '--no-check',
        SECTION_RUNNER,
        section,
      ],
      cwd: REPO_ROOT,
      stdout: 'piped',
      stderr: 'piped',
      signal: controller.signal,
    });

    const proc = cmd.spawn();

    // Collect stdout
    const decoder = new TextDecoder();
    let stdout = '';
    let stderr = '';

    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();

    // Drain both streams concurrently
    const drainStdout = (async () => {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
    })();
    const drainStderr = (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
    })();

    const status = await proc.status;
    await Promise.all([drainStdout, drainStderr]);

    const elapsedMs = Date.now() - start;
    // Detect timeout: process was killed by signal (via AbortController) OR
    // elapsed time is close to the timeout threshold
    const killedBySignal = status.signal != null;
    const timedOut = killedBySignal || elapsedMs >= SECTION_TIMEOUT_MS - 1000;
    const tests = parseOutput(stdout);
    return { section, tests, output: stdout, timedOut, elapsedMs };
  } catch (err: unknown) {
    const elapsedMs = Date.now() - start;
    const timedOut = (err instanceof Error && err.name === 'AbortError') ||
      (err instanceof DOMException && err.name === 'AbortError') ||
      elapsedMs >= SECTION_TIMEOUT_MS - 1000;
    return { section, tests: [], output: '', timedOut, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main: run all sections sequentially
// ---------------------------------------------------------------------------

console.log('[coreutils-pysuite] running test_coreutils.py section by section...');
console.log(`[coreutils-pysuite] ${SECTIONS.length} sections, fresh subprocess per section`);

const allResults: SectionResult[] = [];
const totalStart = Date.now();

for (const section of SECTIONS) {
  process.stdout.write(`[coreutils-pysuite]   ${section}... `);
  const result = await runSection(section);
  const pass = result.tests.filter(t => t.status === 'PASS').length;
  const fail = result.tests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').length;
  const skip = result.tests.filter(t => t.status === 'SKIP').length;
  const flag = result.timedOut ? ' [TIMEOUT]' : '';
  console.log(`${pass}p/${fail}f/${skip}s in ${(result.elapsedMs / 1000).toFixed(1)}s${flag}`);
  allResults.push(result);
}

const totalElapsedSec = ((Date.now() - totalStart) / 1000).toFixed(1);

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

const allTests = allResults.flatMap(r => r.tests);
const passed = allTests.filter(t => t.status === 'PASS').length;
const failed = allTests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').length;
const skipped = allTests.filter(t => t.status === 'SKIP').length;
const total = passed + failed + skipped;
const timedOutSections = allResults.filter(r => r.timedOut).map(r => r.section);

console.log(`\n[coreutils-pysuite] Results: ${passed} pass / ${failed} fail / ${skipped} skip / ${total} total in ${totalElapsedSec}s`);
if (timedOutSections.length > 0) {
  console.log(`[coreutils-pysuite] Timed-out sections: ${timedOutSections.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Classify failures
// ---------------------------------------------------------------------------

type Classification = 'needs-fork' | 'runtime-gap' | 'test-env' | 'unknown';

interface FailEntry {
  name: string;
  tool: string;
  message: string;
  classification: Classification;
  reason: string;
}

function extractTool(testName: string): string {
  const underscoreIdx = testName.indexOf('_');
  if (underscoreIdx > 0) return testName.substring(0, underscoreIdx);
  return testName;
}

function classifyFailure(name: string, message: string): { classification: Classification; reason: string } {
  const text = (name + ' ' + message).toLowerCase();

  if (text.includes('fork') || text.includes('daemon') || text.includes('execv') ||
      text.includes('job control') || text.includes('signal')) {
    return { classification: 'needs-fork', reason: 'Requires fork()/exec() or Unix job control (§Non-Goals, spec line 81)' };
  }
  if (text.includes('network') || text.includes('socket') || text.includes('connect') ||
      text.includes('curl') || text.includes('wget')) {
    return { classification: 'test-env', reason: 'Requires network access not available in sandbox' };
  }
  if (text.includes('tty') || text.includes('terminal') || text.includes('isatty')) {
    return { classification: 'test-env', reason: 'Requires TTY not available in sandbox' };
  }
  if (text.includes('permission') || text.includes('operation not permitted')) {
    return { classification: 'test-env', reason: 'Requires Unix permissions or root not available in sandbox' };
  }
  if (text.includes('assert') || text.includes('expected') || text.includes('got')) {
    return { classification: 'runtime-gap', reason: 'Output mismatch — possible coreutils WASM behavior gap vs expected output' };
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return { classification: 'runtime-gap', reason: 'Command timed out — sandbox performance or blocking call gap' };
  }
  if (text.includes('not found') || text.includes('no such') || text.includes('command')) {
    return { classification: 'runtime-gap', reason: 'Command not found or file missing — binary not registered in sandbox' };
  }
  return { classification: 'unknown', reason: 'Needs investigation' };
}

const failedTests = allTests.filter(t => t.status === 'FAIL' || t.status === 'ERROR');
const failEntries: FailEntry[] = failedTests.map(t => {
  const { classification, reason } = classifyFailure(t.name, t.message);
  return { name: t.name, tool: extractTool(t.name), message: t.message, classification, reason };
});

const tally = { 'needs-fork': 0, 'runtime-gap': 0, 'test-env': 0, 'unknown': 0 };
for (const e of failEntries) tally[e.classification]++;

// ---------------------------------------------------------------------------
// Write findings doc
// ---------------------------------------------------------------------------

mkdirSync(FINDINGS_DIR, { recursive: true });

const sectionSummaryRows = allResults.map(r => {
  const p = r.tests.filter(t => t.status === 'PASS').length;
  const f = r.tests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').length;
  const s = r.tests.filter(t => t.status === 'SKIP').length;
  const flag = r.timedOut ? ' (TIMEOUT)' : '';
  return `| \`${r.section}\` | ${p} | ${f} | ${s} | ${(r.elapsedMs / 1000).toFixed(1)}s${flag} |`;
}).join('\n');

const failSections = failEntries.map(e => `
### FAIL: ${e.name}

- **Tool**: \`${e.tool}\`
- **Classification**: \`${e.classification}\`
- **Reason**: ${e.reason}
- **Message**: ${e.message || '(none)'}
`).join('\n---\n');

const toleranceNote = timedOutSections.length > 0
  ? `**Exit policy**: ${timedOutSections.length} section(s) timed out (${timedOutSections.join(', ')}). Timeouts fail the run; investigate.`
  : failed === 0
  ? `**Exit policy**: all sections green. Exiting 0.`
  : `**Exit policy**: ${failed} failure(s). Exiting 1. Known-open failures tracked in the ledger; runner does not silently accept them.`;

const doc = `# Coreutils test_coreutils.py on Codepod — ${new Date().toISOString().split('T')[0]}

**Runner**: \`scripts/run-coreutils-pysuite-in-sandbox.ts\`
**Strategy**: Fresh Deno subprocess per section (${SECTIONS.length} sections × 1 sandbox each)
**Total elapsed**: ${totalElapsedSec}s
**Test script**: \`packages/coreutils/tests/test_coreutils.py\` (unmodified)
**Sandbox fixtures**: \`packages/orchestrator/src/platform/__tests__/fixtures/\`

## Performance Context

Running \`test_coreutils.py\` via RustPython-in-WASM is memory-intensive: each \`subprocess.run()\`
call spawns a new WASM process and the V8 heap is not reclaimed between calls within the same
Deno process. The runner uses a **separate Deno subprocess per section** (via \`Deno.Command\`
with \`AbortController\` timeout) to isolate heap usage. This gives true OS-level kill on timeout
and complete WASM memory reclamation between sections.

The per-section helper is \`scripts/run-coreutils-section.ts\`. The test_coreutils.py module is
loaded via \`importlib\` so its \`if __name__ == "__main__"\` block does not run; only the
specified \`register_*_tests()\` function is called.

## Summary

| Category | Count |
|---|---|
| PASS | ${passed} |
| FAIL | ${failed} |
| SKIP | ${skipped} |
| **Total** | **${total}** |

### Failure breakdown

| Classification | Count |
|---|---|
| \`needs-fork\` | ${tally['needs-fork']} |
| \`runtime-gap\` | ${tally['runtime-gap']} |
| \`test-env\` | ${tally['test-env']} |
| \`unknown\` | ${tally['unknown']} |

${toleranceNote}

## Per-Section Results

| Section | PASS | FAIL | SKIP | Time |
|---|---|---|---|---|
${sectionSummaryRows}

## Classification Key

- **\`needs-fork\`**: Genuine §Non-Goals per spec lines 76–88 (\`fork()\`/\`execve()\`/job control). Legit skip.
- **\`runtime-gap\`**: Codepod should support this, currently doesn't. Tracked follow-up.
- **\`test-env\`**: Test expects specific env (TTY, root, /proc, network) not in sandbox. Usually harness-setup fix.
- **\`unknown\`**: Needs investigation.

## Exit Policy

Any failure or timeout fails the run. Known-open failures are tracked in
\`docs/superpowers/acceptance/2026-04-22-guest-compat-runtime-acceptance.md\`
under "Known-open items," not hidden behind a tolerance threshold.

## Per-Failure Details

${failEntries.length === 0 ? '_No failures!_' : failSections}

## Timed-Out Sections

${timedOutSections.length === 0
  ? '_None._'
  : timedOutSections.map(s => `- \`${s}\``).join('\n')}
`;

writeFileSync(FINDINGS_FILE, doc, 'utf-8');
console.log(`[coreutils-pysuite] findings written to ${FINDINGS_FILE}`);

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (failed > 0 || timedOutSections.length > 0) {
  console.error(
    `\n[coreutils-pysuite] FAIL: ${failed} failure(s), ${timedOutSections.length} timeout(s).`,
  );
  Deno.exit(1);
} else {
  console.log(`\n[coreutils-pysuite] OK: ${passed} pass, ${skipped} skip`);
  Deno.exit(0);
}
