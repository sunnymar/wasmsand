# Browser Tester Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an in-browser shell experience using Vite + xterm.js, proving the full wasmsand stack (VFS, ProcessManager, ShellRunner, coreutils, Python) works in the browser.

**Architecture:** A `packages/web/` Vite app serves WASM binaries as static assets. On page load, `main.ts` creates VFS + BrowserAdapter + ProcessManager + ShellRunner, then wires an xterm.js terminal to ShellRunner.run(). Line-buffered input, full output on command completion.

**Tech Stack:** Vite, xterm.js, @xterm/addon-fit, @wasmsand/orchestrator (ESM).

---

### Task 1: Export Orchestrator Public API

**Files:**
- Modify: `packages/orchestrator/src/index.ts`

**Context:** The orchestrator's index.ts currently exports nothing (`export {}`). The web package needs to import VFS, ProcessManager, ShellRunner, BrowserAdapter, PythonRunner, and types. All these classes already have `export` on their declarations — we just need to re-export them from the barrel file.

**Step 1: Rewrite index.ts**

```typescript
// @wasmsand/orchestrator - WASM AI Sandbox
export { VFS } from './vfs/vfs.js';
export { ProcessManager } from './process/manager.js';
export { ShellRunner } from './shell/shell-runner.js';
export { PythonRunner } from './python/python-runner.js';
export { BrowserAdapter } from './platform/browser-adapter.js';
export { NodeAdapter } from './platform/node-adapter.js';
export type { PlatformAdapter } from './platform/adapter.js';
export type { SpawnOptions, SpawnResult } from './process/process.js';
export type { RunResult } from './shell/shell-runner.js';
```

**Step 2: Build the orchestrator to verify exports compile**

Run: `cd packages/orchestrator && npx tsup`

Expected: Build succeeds, `dist/index.js` and `dist/index.d.ts` contain the exports.

**Step 3: Run existing tests to verify nothing broke**

Run: `cd packages/orchestrator && npx vitest run`

Expected: 246 passed, 1 skipped.

**Step 4: Commit**

```bash
git add packages/orchestrator/src/index.ts
git commit -m "feat: export orchestrator public API from index.ts"
```

---

### Task 2: Scaffold Web Package

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/index.html`

**Context:** Set up the Vite project structure with dependencies. No application code yet — just the skeleton that can `vite dev` and show a blank page.

**Step 1: Create package.json**

`packages/web/package.json`:
```json
{
  "name": "@wasmsand/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@xterm/xterm": "^5.5",
    "@xterm/addon-fit": "^0.10"
  },
  "devDependencies": {
    "vite": "^6.0",
    "typescript": "^5.7"
  }
}
```

Note: We do NOT add `@wasmsand/orchestrator` as a dependency — we import its source directly via relative path (monorepo, same TS toolchain, Vite resolves `.ts` imports natively).

**Step 2: Create tsconfig.json**

`packages/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": {
      "@wasmsand/orchestrator": ["../orchestrator/src/index.ts"]
    }
  },
  "include": ["src"]
}
```

**Step 3: Create index.html**

`packages/web/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>wasmsand</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: #1e1e2e; overflow: hidden; }
    #terminal { height: 100%; width: 100%; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 4: Install dependencies**

Run: `cd packages/web && npm install`

**Step 5: Commit**

```bash
git add packages/web/
git commit -m "feat: scaffold web package with Vite + xterm.js"
```

---

### Task 3: Copy WASM Binaries to Public Directory

**Files:**
- Create: `packages/web/public/wasm/` (directory with .wasm files)
- Create: `packages/web/copy-wasm.sh`

**Context:** Vite serves files from `public/` as static assets at the root URL. WASM binaries need to be accessible at `/wasm/cat.wasm`, `/wasm/python3.wasm`, etc. We copy from the orchestrator's test fixtures.

**Step 1: Create the copy script**

`packages/web/copy-wasm.sh`:
```bash
#!/bin/bash
set -euo pipefail

FIXTURES="../orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES="../orchestrator/src/shell/__tests__/fixtures"
OUT="public/wasm"

mkdir -p "$OUT"

# Shell parser
cp "$SHELL_FIXTURES/wasmsand-shell.wasm" "$OUT/"

# Python
cp "$FIXTURES/python3.wasm" "$OUT/"

# Coreutils
for tool in cat echo head tail wc sort uniq grep ls mkdir rm cp mv touch tee tr cut basename dirname env printf find sed awk jq; do
  cp "$FIXTURES/${tool}.wasm" "$OUT/"
done

# true/false have special filenames
cp "$FIXTURES/true-cmd.wasm" "$OUT/"
cp "$FIXTURES/false-cmd.wasm" "$OUT/"

echo "Copied $(ls "$OUT"/*.wasm | wc -l | tr -d ' ') wasm binaries to $OUT/"
du -sh "$OUT"
```

**Step 2: Run the copy script**

Run: `cd packages/web && bash copy-wasm.sh`

Expected: ~28 wasm files in `public/wasm/`, total ~50MB (python3.wasm is 44MB).

**Step 3: Add public/wasm/ to .gitignore**

These are build artifacts — don't commit them. Create `packages/web/.gitignore`:
```
public/wasm/
node_modules/
dist/
```

**Step 4: Commit**

```bash
git add packages/web/copy-wasm.sh packages/web/.gitignore
git commit -m "feat: add wasm binary copy script for web package"
```

---

### Task 4: Create Terminal Bridge

**Files:**
- Create: `packages/web/src/terminal.ts`

**Context:** This file bridges xterm.js and ShellRunner. It handles line-buffered input (collecting keystrokes until Enter), sends the line to ShellRunner.run(), writes stdout/stderr to the terminal, and re-renders the prompt. It also handles Backspace, Ctrl+C (cancel current line), and Ctrl+L (clear screen).

**Step 1: Write terminal.ts**

`packages/web/src/terminal.ts`:
```typescript
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ShellRunner } from '../../orchestrator/src/shell/shell-runner.js';

const PROMPT = '$ ';

export function createTerminal(
  container: HTMLElement,
  runner: ShellRunner,
): Terminal {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b7066',
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  window.addEventListener('resize', () => fit.fit());

  let currentLine = '';
  let running = false;
  const history: string[] = [];
  let historyIndex = -1;

  function prompt(): void {
    term.write(PROMPT);
  }

  function printBanner(): void {
    term.writeln('wasmsand — WebAssembly sandbox shell');
    term.writeln('Type shell commands. Python: python3 -c "print(1+1)"');
    term.writeln('');
  }

  printBanner();
  prompt();

  term.onKey(async ({ key, domEvent }) => {
    if (running) return;

    const code = domEvent.keyCode;

    // Enter
    if (code === 13) {
      term.writeln('');
      const line = currentLine.trim();
      currentLine = '';
      historyIndex = -1;

      if (line === '') {
        prompt();
        return;
      }

      history.push(line);
      running = true;

      try {
        const result = await runner.run(line);

        if (result.stdout) {
          // Ensure \n renders as \r\n for xterm
          term.write(result.stdout.replace(/\n/g, '\r\n'));
        }
        if (result.stderr) {
          term.write(`\x1b[31m${result.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        term.writeln(`\x1b[31mError: ${msg}\x1b[0m`);
      }

      running = false;
      prompt();
      return;
    }

    // Backspace
    if (code === 8) {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }

    // Ctrl+C
    if (domEvent.ctrlKey && code === 67) {
      currentLine = '';
      term.writeln('^C');
      prompt();
      return;
    }

    // Ctrl+L (clear)
    if (domEvent.ctrlKey && code === 76) {
      term.clear();
      prompt();
      term.write(currentLine);
      return;
    }

    // Up arrow (history)
    if (code === 38) {
      if (history.length > 0) {
        if (historyIndex === -1) historyIndex = history.length;
        if (historyIndex > 0) {
          historyIndex--;
          // Clear current line
          term.write('\r' + PROMPT + ' '.repeat(currentLine.length) + '\r' + PROMPT);
          currentLine = history[historyIndex];
          term.write(currentLine);
        }
      }
      return;
    }

    // Down arrow (history)
    if (code === 40) {
      if (historyIndex !== -1) {
        historyIndex++;
        term.write('\r' + PROMPT + ' '.repeat(currentLine.length) + '\r' + PROMPT);
        if (historyIndex >= history.length) {
          historyIndex = -1;
          currentLine = '';
        } else {
          currentLine = history[historyIndex];
          term.write(currentLine);
        }
      }
      return;
    }

    // Regular printable character
    if (key.length === 1 && !domEvent.ctrlKey && !domEvent.altKey && !domEvent.metaKey) {
      currentLine += key;
      term.write(key);
    }
  });

  return term;
}
```

**Step 2: Commit**

```bash
git add packages/web/src/terminal.ts
git commit -m "feat: add xterm.js terminal bridge with line input and history"
```

---

### Task 5: Create Main Entry Point and Wire Everything Together

**Files:**
- Create: `packages/web/src/main.ts`
- Create: `packages/web/vite.config.ts`

**Context:** This is the boot file. It creates the full wasmsand stack (VFS → BrowserAdapter → ProcessManager → ShellRunner), registers all WASM tools, and connects to the terminal. It also needs a Vite config to resolve the orchestrator source imports.

**Step 1: Create vite.config.ts**

`packages/web/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@wasmsand/orchestrator': resolve(__dirname, '../orchestrator/src/index.ts'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

Note: The COOP/COEP headers enable `SharedArrayBuffer` which some WASM runtimes may need. Not strictly required now but good practice.

**Step 2: Create main.ts**

`packages/web/src/main.ts`:
```typescript
import { VFS, ProcessManager, ShellRunner, BrowserAdapter } from '@wasmsand/orchestrator';
import { createTerminal } from './terminal.js';
import '@xterm/xterm/css/xterm.css';

const WASM_BASE = '/wasm';

const TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf', 'find', 'sed', 'awk', 'jq',
];

/** Map tool name to wasm filename. */
function wasmUrl(tool: string): string {
  return `${WASM_BASE}/${tool}.wasm`;
}

async function boot(): Promise<void> {
  const vfs = new VFS();
  const adapter = new BrowserAdapter();
  const mgr = new ProcessManager(vfs, adapter);

  // Register coreutils
  for (const tool of TOOLS) {
    mgr.registerTool(tool, wasmUrl(tool));
  }

  // true/false have special wasm filenames
  mgr.registerTool('true', `${WASM_BASE}/true-cmd.wasm`);
  mgr.registerTool('false', `${WASM_BASE}/false-cmd.wasm`);

  // Register python3
  mgr.registerTool('python3', `${WASM_BASE}/python3.wasm`);

  const shellWasmUrl = `${WASM_BASE}/wasmsand-shell.wasm`;
  const runner = new ShellRunner(vfs, mgr, adapter, shellWasmUrl);

  const container = document.getElementById('terminal');
  if (!container) throw new Error('Missing #terminal element');

  createTerminal(container, runner);
}

boot().catch((err) => {
  document.body.textContent = `Boot failed: ${err.message}`;
  console.error(err);
});
```

**Step 3: Start the dev server and verify it loads**

Run: `cd packages/web && npx vite`

Expected: Server starts at http://localhost:5173. Opening in browser shows a dark terminal with the banner text and a `$ ` prompt. Typing `echo hello` and pressing Enter should print `hello`.

**Step 4: Commit**

```bash
git add packages/web/src/main.ts packages/web/vite.config.ts
git commit -m "feat: wire up browser shell with VFS, ProcessManager, and ShellRunner"
```

---

### Task 6: Manual Smoke Test and Fixes

**Files:**
- Possibly modify: `packages/web/src/terminal.ts`
- Possibly modify: `packages/web/src/main.ts`
- Possibly modify: `packages/orchestrator/src/platform/browser-adapter.ts`

**Context:** Test the full stack in the browser. Things that might break: BrowserAdapter fetch paths, WASM MIME types, xterm.js rendering quirks, stdout newline handling. Fix whatever comes up.

**Step 1: Test these commands in the browser**

Open http://localhost:5173 and run:

```
echo hello world
ls /
cat /dev/null
echo foo > /tmp/test.txt && cat /tmp/test.txt
echo hello | wc -c
ls /bin
mkdir /tmp/mydir && touch /tmp/mydir/file.txt && ls /tmp/mydir
python3 -c "print(1 + 1)"
python3 -c "import json; print(json.dumps({'a': 1}))"
echo '{"name":"Alice"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])"
```

**Step 2: Fix any issues found**

Common fixes:
- If BrowserAdapter fails to fetch, check that the wasm URL is correct and the file exists in `public/wasm/`
- If xterm.js shows garbled output, check the `\n` → `\r\n` conversion in terminal.ts
- If the terminal doesn't resize properly, verify the FitAddon is working

**Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "fix: browser smoke test fixes"
```

---

### Task 7: Run Existing Tests (Regression Check)

**Files:** None modified.

**Context:** Verify that the orchestrator changes (index.ts exports) didn't break anything.

**Step 1: Run orchestrator test suite**

Run: `cd packages/orchestrator && npx vitest run`

Expected: 246 passed, 1 skipped.

**Step 2: Done**

If all tests pass, Phase 1 is complete. The browser tester works.
