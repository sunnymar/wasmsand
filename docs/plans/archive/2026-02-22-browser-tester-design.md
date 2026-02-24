# Browser Tester & Coreutils Gap-Fill — Design

**Goal:** Ship an in-browser shell experience proving the full wasmsand stack works in the browser, then fill coreutils gaps so LLM-generated shell scripts work out of the box.

**Two independent phases:**

---

## Phase 1: Browser Tester

A `packages/web/` Vite app with xterm.js providing a full shell in the browser.

### Architecture

```
index.html
  └─ main.ts (boot)
       ├─ Creates VFS, BrowserAdapter, ProcessManager
       ├─ Registers tools (URLs to /wasm/*.wasm, lazy-fetched on first use)
       ├─ Creates ShellRunner
       └─ Wires to xterm.js terminal
            └─ terminal.ts (bridge)
                 ├─ Line-buffered input
                 ├─ On Enter → ShellRunner.run(line)
                 ├─ Writes stdout/stderr to xterm
                 └─ Re-renders prompt
```

### WASM Loading

BrowserAdapter uses `fetch()` + `WebAssembly.compileStreaming()`. ProcessManager caches compiled modules. First `python3` invocation fetches 44MB; subsequent calls are instant.

All wasm binaries served as static assets from `public/wasm/`.

### Files

**Create:**
- `packages/web/package.json` — deps: vite, xterm.js, @xterm/addon-fit, @wasmsand/orchestrator
- `packages/web/tsconfig.json`
- `packages/web/index.html` — minimal HTML with `<div id="terminal">`
- `packages/web/src/main.ts` — boot: VFS → BrowserAdapter → ProcessManager → ShellRunner → terminal
- `packages/web/src/terminal.ts` — xterm.js bridge: line input, output rendering, prompt
- `packages/web/public/wasm/` — copies/symlinks of all wasm binaries

**Modify:**
- `packages/orchestrator/src/index.ts` — export VFS, ProcessManager, ShellRunner, PythonRunner, BrowserAdapter, PlatformAdapter, SpawnResult, RunResult

### WASM Binaries to Serve

Shell parser: `wasmsand-shell.wasm`
Python: `python3.wasm`
Coreutils: `awk`, `basename`, `cat`, `cp`, `cut`, `dirname`, `echo`, `env`, `find`, `grep`, `head`, `jq`, `ls`, `mkdir`, `mv`, `printf`, `rm`, `sed`, `sort`, `tail`, `tee`, `touch`, `tr`, `true`, `false`, `uniq`, `wc`

### Tech Stack

- **Vite** — dev server with HMR, correct wasm MIME types, static asset serving
- **xterm.js** + **@xterm/addon-fit** — terminal emulator with ANSI support, scrollback, copy/paste
- **@wasmsand/orchestrator** — existing library, just needs exports

---

## Phase 2: Coreutils Gap-Fill

Fill gaps vs. busybox's standard applet set. These are what LLMs expect to exist.

### Shell Builtins (TypeScript in shell-runner.ts)

- **`test` / `[`** — file tests (`-f`, `-d`, `-e`, `-r`, `-w`, `-x`, `-s`), string tests (`-z`, `-n`, `=`, `!=`), integer comparisons (`-eq`, `-ne`, `-lt`, `-gt`, `-le`, `-ge`), logical operators (`!`, `-a`, `-o`)
- **`pwd`** — returns current working directory

### New Rust Coreutils (<30 lines each)

| Command | Description |
|---------|-------------|
| `xargs` | Build and execute commands from stdin |
| `seq` | Print numeric sequences |
| `sleep` | No-op stub (exit 0, no actual delay) |
| `date` | Print current date (fixed or from env) |
| `mktemp` | Create temporary file, print path |
| `expr` | Evaluate expressions |
| `yes` | Repeatedly output a string |
| `rmdir` | Remove empty directories |
| `ln` | Create links (symlinks not supported, hard links via VFS copy) |
| `readlink` | Print resolved path |
| `realpath` | Print absolute path |
| `printenv` | Print environment variables |
| `uname` | Print system info (returns "wasmsand") |
| `whoami` | Print current user (returns "user") |
| `id` | Print user identity (returns "uid=1000(user)") |
| `tac` | Concatenate and print files in reverse |
| `diff` | Compare files line by line |

### Independence

Each coreutil is a standalone Rust binary. All 17 can be implemented in parallel. No dependencies between them or on Phase 1.
