# Python Integration via Monty — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable `python3 script.py` and `python3 -c "code"` in the sandbox shell, with VFS file I/O and pipeline support, using Pydantic Monty.

**Architecture:** Monty (`@pydantic/monty`) is a Rust-based Python interpreter with a NAPI binding for Node.js. Python execution is handled by a `PythonRunner` class that creates Monty instances, bridges external functions (file I/O, subprocess) to our VFS and ShellRunner, captures stdout/stderr via `printCallback`, and returns `SpawnResult`. The ShellRunner delegates `python3` commands to PythonRunner instead of the ProcessManager.

**Tech Stack:** `@pydantic/monty` (npm), TypeScript, vitest

---

## Task 1: Install Monty and write basic PythonRunner tests

**Files:**
- Modify: `packages/orchestrator/package.json` (add dependency)
- Create: `packages/orchestrator/src/python/python-runner.ts`
- Create: `packages/orchestrator/src/python/__tests__/python-runner.test.ts`

**Step 1: Verify Monty is installed**

The package was already installed during design exploration. Verify:

```bash
node -e "const {Monty} = require('@pydantic/monty'); console.log('ok')"
```

Expected: `ok`

**Step 2: Write failing tests**

```typescript
// packages/orchestrator/src/python/__tests__/python-runner.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PythonRunner } from '../python-runner.js';
import { VFS } from '../../vfs/vfs.js';

describe('PythonRunner', () => {
  let vfs: VFS;
  let runner: PythonRunner;

  beforeEach(() => {
    vfs = new VFS();
    runner = new PythonRunner(vfs);
  });

  describe('basic execution', () => {
    it('evaluates simple expression', async () => {
      const result = await runner.run({
        args: ['-c', 'print(1 + 2)'],
        env: {},
      });
      expect(result.stdout).toBe('3\n');
      expect(result.exitCode).toBe(0);
    });

    it('evaluates multi-line code', async () => {
      const result = await runner.run({
        args: ['-c', 'x = 10\ny = 20\nprint(x + y)'],
        env: {},
      });
      expect(result.stdout).toBe('30\n');
    });

    it('captures multiple print calls', async () => {
      const result = await runner.run({
        args: ['-c', 'print("hello")\nprint("world")'],
        env: {},
      });
      expect(result.stdout).toBe('hello\nworld\n');
    });

    it('returns exit code 1 on runtime error', async () => {
      const result = await runner.run({
        args: ['-c', '1 / 0'],
        env: {},
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ZeroDivisionError');
    });

    it('returns exit code 2 on syntax error', async () => {
      const result = await runner.run({
        args: ['-c', 'def foo('],
        env: {},
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('SyntaxError');
    });
  });
});
```

**Step 3: Run tests to verify they fail**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-runner.test.ts
```

Expected: FAIL (PythonRunner doesn't exist yet)

**Step 4: Implement minimal PythonRunner**

```typescript
// packages/orchestrator/src/python/python-runner.ts
import { Monty, MontySyntaxError, MontyRuntimeError } from '@pydantic/monty';
import type { VFS } from '../vfs/vfs.js';
import type { SpawnOptions, SpawnResult } from '../process/process.js';

export class PythonRunner {
  private vfs: VFS;

  constructor(vfs: VFS) {
    this.vfs = vfs;
  }

  async run(opts: SpawnOptions): Promise<SpawnResult> {
    const startTime = performance.now();

    // Extract code from args
    const code = this.extractCode(opts.args);
    if (code === null) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'python3: missing -c or script argument\n',
        executionTimeMs: performance.now() - startTime,
      };
    }

    // Capture stdout/stderr
    let stdout = '';
    let stderr = '';
    const printCallback = (stream: string, text: string) => {
      if (stream === 'stderr') {
        stderr += text;
      } else {
        stdout += text;
      }
    };

    try {
      const monty = new Monty(code);
      monty.run({ printCallback });

      return {
        exitCode: 0,
        stdout,
        stderr,
        executionTimeMs: performance.now() - startTime,
      };
    } catch (err) {
      if (err instanceof MontySyntaxError) {
        return {
          exitCode: 2,
          stdout,
          stderr: err.display('traceback') + '\n',
          executionTimeMs: performance.now() - startTime,
        };
      }
      if (err instanceof MontyRuntimeError) {
        return {
          exitCode: 1,
          stdout,
          stderr: err.display('traceback') + '\n',
          executionTimeMs: performance.now() - startTime,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        stdout,
        stderr: msg + '\n',
        executionTimeMs: performance.now() - startTime,
      };
    }
  }

  private extractCode(args: string[]): string | null {
    // python3 -c "code"
    const cIndex = args.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < args.length) {
      return args[cIndex + 1];
    }

    // python3 script.py — read from VFS
    const scriptArg = args.find(a => a.endsWith('.py') || (!a.startsWith('-') && a !== 'python3'));
    if (scriptArg) {
      try {
        const data = this.vfs.readFile(scriptArg);
        return new TextDecoder().decode(data);
      } catch {
        return null;
      }
    }

    return null;
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-runner.test.ts
```

Expected: All 5 pass

**Step 6: Commit**

```bash
git add packages/orchestrator/src/python/ packages/orchestrator/package.json
git commit -m "feat: add PythonRunner with basic Monty execution"
```

---

## Task 2: Script file execution and VFS file I/O

**Files:**
- Modify: `packages/orchestrator/src/python/python-runner.ts`
- Modify: `packages/orchestrator/src/python/__tests__/python-runner.test.ts`

**Step 1: Write failing tests**

Add to the test file:

```typescript
  describe('script file execution', () => {
    it('runs a .py script from VFS', async () => {
      vfs.writeFile('/home/user/hello.py',
        new TextEncoder().encode('print("hello from script")'));
      const result = await runner.run({
        args: ['/home/user/hello.py'],
        env: {},
      });
      expect(result.stdout).toBe('hello from script\n');
      expect(result.exitCode).toBe(0);
    });

    it('returns error for missing script', async () => {
      const result = await runner.run({
        args: ['/home/user/missing.py'],
        env: {},
      });
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('VFS file I/O via external functions', () => {
    it('reads a file from VFS', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('file content'));
      const result = await runner.run({
        args: ['-c', 'content = read_file("/home/user/data.txt")\nprint(content)'],
        env: {},
      });
      expect(result.stdout).toBe('file content\n');
    });

    it('writes a file to VFS', async () => {
      const result = await runner.run({
        args: ['-c', 'write_file("/home/user/out.txt", "from python")'],
        env: {},
      });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(vfs.readFile('/home/user/out.txt'))).toBe('from python');
    });

    it('lists directory contents', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode(''));
      const result = await runner.run({
        args: ['-c', 'items = list_dir("/home/user")\nfor f in items:\n  print(f)'],
        env: {},
      });
      expect(result.stdout).toContain('a.txt');
      expect(result.stdout).toContain('b.txt');
    });

    it('checks file existence', async () => {
      vfs.writeFile('/home/user/exists.txt', new TextEncoder().encode(''));
      const result = await runner.run({
        args: ['-c', 'print(file_exists("/home/user/exists.txt"))\nprint(file_exists("/home/user/nope.txt"))'],
        env: {},
      });
      expect(result.stdout).toBe('True\nFalse\n');
    });
  });
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-runner.test.ts
```

Expected: New tests FAIL (external functions not implemented)

**Step 3: Add external function bridge to PythonRunner**

Modify `python-runner.ts` to use Monty's `start()`/`resume()` snapshot mechanism for external function calls:

```typescript
// Add these imports at the top
import { Monty, MontySnapshot, MontyComplete, MontySyntaxError, MontyRuntimeError } from '@pydantic/monty';

// Replace the run() method's try block with:
    try {
      const monty = new Monty(code, {
        externalFunctions: [
          'read_file', 'write_file', 'list_dir', 'file_exists',
          'read_stdin',
        ],
      });

      let progress: MontySnapshot | MontyComplete = monty.start({ printCallback });

      while (progress instanceof MontySnapshot) {
        const fnName = progress.functionName;
        const fnArgs = progress.args;

        try {
          const returnValue = this.handleExternalCall(fnName, fnArgs, opts);
          progress = progress.resume({ returnValue });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progress = progress.resume({
            exception: { type: 'OSError', message: msg },
          });
        }
      }

      return {
        exitCode: 0,
        stdout,
        stderr,
        executionTimeMs: performance.now() - startTime,
      };
    }
```

Add the external call handler method:

```typescript
  private handleExternalCall(
    name: string,
    args: unknown[],
    opts: SpawnOptions,
  ): unknown {
    switch (name) {
      case 'read_file': {
        const path = String(args[0]);
        const data = this.vfs.readFile(path);
        return new TextDecoder().decode(data);
      }
      case 'write_file': {
        const path = String(args[0]);
        const content = String(args[1]);
        this.vfs.writeFile(path, new TextEncoder().encode(content));
        return null;
      }
      case 'list_dir': {
        const path = String(args[0]);
        return this.vfs.readdir(path);
      }
      case 'file_exists': {
        const path = String(args[0]);
        try {
          this.vfs.stat(path);
          return true;
        } catch {
          return false;
        }
      }
      case 'read_stdin': {
        if (opts.stdinData) {
          return new TextDecoder().decode(opts.stdinData);
        }
        return '';
      }
      default:
        throw new Error(`Unknown external function: ${name}`);
    }
  }
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-runner.test.ts
```

Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/orchestrator/src/python/
git commit -m "feat: add VFS file I/O bridge for Python via external functions"
```

---

## Task 3: Stdin piping and resource limits

**Files:**
- Modify: `packages/orchestrator/src/python/python-runner.ts`
- Modify: `packages/orchestrator/src/python/__tests__/python-runner.test.ts`

**Step 1: Write failing tests**

```typescript
  describe('stdin piping', () => {
    it('reads stdin data', async () => {
      const result = await runner.run({
        args: ['-c', 'data = read_stdin()\nprint(data.strip())'],
        env: {},
        stdinData: new TextEncoder().encode('piped input\n'),
      });
      expect(result.stdout).toBe('piped input\n');
    });

    it('handles empty stdin', async () => {
      const result = await runner.run({
        args: ['-c', 'data = read_stdin()\nprint(len(data))'],
        env: {},
      });
      expect(result.stdout).toBe('0\n');
    });
  });

  describe('resource limits', () => {
    it('terminates infinite loops', async () => {
      const result = await runner.run({
        args: ['-c', 'while True:\n  pass'],
        env: {},
      });
      // Should fail with a resource limit error, not hang
      expect(result.exitCode).not.toBe(0);
    });
  });
```

**Step 2: Run to verify they fail**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-runner.test.ts
```

**Step 3: Add resource limits to PythonRunner**

In the `run()` method, add resource limits to the `start()` call:

```typescript
      let progress: MontySnapshot | MontyComplete = monty.start({
        printCallback,
        limits: {
          maxDurationSecs: 10,
          maxAllocations: 1_000_000,
          maxMemory: 64 * 1024 * 1024, // 64MB
          maxRecursionDepth: 500,
        },
      });
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-runner.test.ts
```

Expected: All tests pass (infinite loop terminated by maxDurationSecs)

**Step 5: Commit**

```bash
git add packages/orchestrator/src/python/
git commit -m "feat: add stdin piping and resource limits to PythonRunner"
```

---

## Task 4: Integrate with ShellRunner

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts`
- Create: `packages/orchestrator/src/python/__tests__/python-shell-integration.test.ts`

**Step 1: Write failing integration tests**

```typescript
// packages/orchestrator/src/python/__tests__/python-shell-integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { ShellRunner } from '../../shell/shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../../shell/__tests__/fixtures/wasmsand-shell.wasm');

const TOOLS = ['cat', 'echo', 'grep', 'sort', 'wc', 'head'];

describe('Python via ShellRunner', () => {
  let vfs: VFS;
  let runner: ShellRunner;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, `${tool}.wasm`));
    }
    runner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
  });

  it('runs python3 -c', async () => {
    const result = await runner.run('python3 -c "print(1 + 2)"');
    expect(result.stdout).toBe('3\n');
    expect(result.exitCode).toBe(0);
  });

  it('runs python3 script.py', async () => {
    vfs.writeFile('/home/user/hello.py',
      new TextEncoder().encode('print("hello from python")'));
    const result = await runner.run('python3 /home/user/hello.py');
    expect(result.stdout).toBe('hello from python\n');
  });

  it('python in a pipeline (stdin)', async () => {
    const result = await runner.run(
      'echo hello world | python3 -c "data = read_stdin()\nprint(data.upper().strip())"'
    );
    expect(result.stdout.trim()).toBe('HELLO WORLD');
  });

  it('python output piped to coreutils', async () => {
    const result = await runner.run(
      'python3 -c "print(\"banana\")\nprint(\"apple\")\nprint(\"cherry\")" | sort'
    );
    expect(result.stdout).toBe('apple\nbanana\ncherry\n');
  });

  it('python reads VFS file', async () => {
    vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('42'));
    const result = await runner.run(
      'python3 -c "val = read_file(\"/home/user/data.txt\")\nprint(int(val) * 2)"'
    );
    expect(result.stdout.trim()).toBe('84');
  });

  it('python writes VFS file', async () => {
    await runner.run(
      'python3 -c "write_file(\"/home/user/out.txt\", \"written by python\")"'
    );
    expect(new TextDecoder().decode(vfs.readFile('/home/user/out.txt'))).toBe('written by python');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-shell-integration.test.ts
```

Expected: FAIL — ShellRunner doesn't know about `python3`

**Step 3: Modify ShellRunner to support Python**

In `shell-runner.ts`, add:

1. Import PythonRunner:
```typescript
import { PythonRunner } from '../python/python-runner.js';
```

2. Add a `pythonRunner` field initialized lazily:
```typescript
  private pythonRunner: PythonRunner | null = null;

  private getPythonRunner(): PythonRunner {
    if (!this.pythonRunner) {
      this.pythonRunner = new PythonRunner(this.vfs);
    }
    return this.pythonRunner;
  }
```

3. In `execSimple()`, before the `this.mgr.spawn()` call, add a check:
```typescript
    // Handle python3 as a special command
    if (cmdName === 'python3' || cmdName === 'python') {
      try {
        const pyResult = await this.getPythonRunner().run({
          args,
          env: Object.fromEntries(this.env),
          stdinData,
        });
        return {
          exitCode: pyResult.exitCode,
          stdout: pyResult.stdout,
          stderr: pyResult.stderr,
          executionTimeMs: pyResult.executionTimeMs,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          exitCode: 1,
          stdout: '',
          stderr: `python3: ${msg}\n`,
          executionTimeMs: 0,
        };
      }
    }
```

4. Similarly in `execPipeline()`, add the same python check in the pipeline stage handling (where Simple commands in pipelines are dispatched).

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/orchestrator/src/python/__tests__/python-shell-integration.test.ts
```

Expected: All 6 pass

**Step 5: Run ALL tests to ensure nothing broke**

```bash
npx vitest run
```

Expected: All tests pass (existing + new)

**Step 6: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/python/
git commit -m "feat: integrate Python execution via ShellRunner"
```

---

## Task 5: Final cleanup and full test run

**Files:**
- Verify all tests pass
- Ensure package.json has the dependency recorded

**Step 1: Run the full test suite**

```bash
npx vitest run --reporter=verbose
```

Expected: All tests pass

**Step 2: Verify git status is clean**

```bash
git status
```

**Step 3: Final commit if needed**

Only if there are uncommitted changes from the integration.

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Basic PythonRunner with print capture | 5 tests |
| 2 | VFS file I/O bridge via external functions | 4 tests |
| 3 | Stdin piping and resource limits | 3 tests |
| 4 | ShellRunner integration (python3 command dispatch) | 6 tests |
| 5 | Full cleanup and verification | — |

**Total: ~18 new tests across 2 test files**
