# Python Integration via Pydantic Monty

## Decision

Use [Pydantic Monty](https://github.com/pydantic/monty) (`@pydantic/monty` on npm) — a Rust-based Python interpreter compiled to WASM — instead of Pyodide.

**Why Monty over Pyodide:**
- Microsecond startup (~0.06ms vs ~2800ms)
- Tiny footprint (single WASM module vs 15MB+ download)
- Built-in sandboxing: FS/network/env controlled via external functions
- Resource limits built in (max memory, duration, allocations, recursion depth)
- External function model maps directly to our VFS and ShellRunner

**Tradeoff:** Monty supports a subset of Python (no classes yet, limited stdlib). Acceptable for LLM use cases which primarily generate straightforward Python.

## Architecture

Monty runs as a special command — not a WASI binary like coreutils, but a JS-side runtime. When ShellRunner encounters `python3`, it delegates to PythonRunner instead of ProcessManager.

```
ShellRunner.execSimple("python3 script.py")
  → detects "python3" as special command
  → PythonRunner.run(args, env, stdin)
    → reads script from VFS
    → creates Monty instance with external functions
    → executes, captures stdout/stderr
    → returns SpawnResult
```

## Components

### 1. PythonRunner

`packages/orchestrator/src/python/python-runner.ts`

Creates Monty instances with pre-configured external functions. Handles:
- `python3 script.py` — reads script from VFS, executes
- `python3 -c "code"` — executes inline code
- stdin piping — feeds stdin data via external function

Returns `SpawnResult` (same interface as WASI process execution).

### 2. External Function Bridge

Defined inside PythonRunner. Bridges Monty's external function calls to our infrastructure:

| External Function | Maps To |
|---|---|
| `read_file(path)` | `vfs.readFile(path)` |
| `write_file(path, content)` | `vfs.writeFile(path, ...)` |
| `list_dir(path)` | `vfs.readdir(path)` |
| `file_exists(path)` | `vfs.stat(path)` (try/catch) |
| `read_stdin()` | stdin data passed from pipeline |
| `run_command(cmd)` | `shellRunner.run(cmd)` for subprocess |

Python code accesses these via Monty's external function mechanism. A thin Python wrapper makes them feel natural:

```python
# Injected preamble that wraps external functions
import sys
sys.stdin = _StdinWrapper()  # backed by read_stdin()
open = _open_wrapper          # backed by read_file/write_file
```

### 3. ShellRunner Modification

Minimal change to `shell-runner.ts`:
- Add `PythonRunner` as an optional dependency (injected via constructor or setter)
- In `execSimple()`: if command is `python3` or `python`, delegate to PythonRunner
- PythonRunner receives args, env, and stdin data

### 4. Monty Configuration

Each execution gets:
- Resource limits: max duration, max memory, max allocations
- External functions: file I/O, stdin, subprocess
- Input variables: environment variables from shell
- Script name: for error tracebacks

## Data Flow Examples

### Simple execution: `python3 -c "print('hello')"`

1. ShellRunner parses → Simple command `python3` with args `["-c", "print('hello')"]`
2. ShellRunner detects `python3` → calls `pythonRunner.run(args, env, stdin)`
3. PythonRunner extracts `-c` code, creates Monty instance
4. Monty executes, stdout captured via output collection
5. Returns `{ exitCode: 0, stdout: "hello\n", stderr: "" }`

### Pipeline: `cat data.csv | python3 -c "import sys; ..."`

1. Pipeline stage 1 runs `cat`, produces stdout
2. Pipeline stage 2: ShellRunner calls PythonRunner with stdinData
3. PythonRunner registers `read_stdin()` external function returning the data
4. Python code calls `sys.stdin.read()` → bridged to `read_stdin()`
5. Output flows back as stdout

### File I/O: `python3 process.py`

1. PythonRunner reads `/home/user/process.py` from VFS
2. Monty executes with external functions registered
3. When Python calls `open('/home/user/data.txt')`, it invokes `read_file` external function
4. External function reads from VFS and returns content
5. When Python calls `open('/home/user/out.txt', 'w')`, it invokes `write_file`

## Testing Strategy

1. **PythonRunner unit tests** — simple expressions, `-c` flag, script files
2. **External function tests** — VFS read/write, file_exists, list_dir
3. **Pipeline tests** — stdin piping through Python
4. **ShellRunner integration** — `python3` dispatching, mixed pipelines with coreutils
5. **Error handling** — syntax errors, runtime errors, resource limit violations

## Dependencies

- `@pydantic/monty` npm package (v0.0.5+)
- No changes to Rust crates or WASI infrastructure
