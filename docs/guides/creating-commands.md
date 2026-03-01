# Creating WASM Commands

This guide explains how to create new commands (coreutils, custom tools) that run inside the codepod sandbox. Commands are Rust binaries compiled to WebAssembly (WASI P1) and executed by the sandbox's process kernel.

## Process Model

Every command runs as an isolated WASM process. The sandbox provides a mini-POSIX kernel:

```
+-------------------------------------------+
|  Process Kernel (TypeScript)              |
|  Manages processes, pipes, fd tables      |
+-------------------------------------------+
|  Your Command (WASM)                      |
|  Standard Rust — stdin/stdout/stderr/fs   |
+-------------------------------------------+
```

Your command links against standard Rust libraries. The WASI layer transparently maps:

| Rust stdlib | WASI syscall | Kernel provides |
|-------------|-------------|-----------------|
| `std::io::stdin()` | `fd_read(0, ...)` | Pre-loaded bytes, pipe, or /dev/null |
| `std::io::stdout()` | `fd_write(1, ...)` | Capture buffer or pipe to next command |
| `std::io::stderr()` | `fd_write(2, ...)` | Capture buffer |
| `std::fs::File::open()` | `path_open(...)` | In-memory VFS |
| `std::env::args()` | `args_get(...)` | Arguments from the shell |
| `std::env::var()` | `environ_get(...)` | Environment from the shell |
| `std::process::exit()` | `proc_exit(...)` | Reports exit code to caller |

You don't need to know about WASI, pipes, or the kernel. Write normal Rust.

## Quick Start: Add a Command to Coreutils

All standard commands live in `packages/coreutils/` as binary targets in a single Cargo workspace crate.

### 1. Create the source file

```bash
# Example: adding a 'rot13' command
touch packages/coreutils/src/bin/rot13.rs
```

Write standard Rust:

```rust
use std::env;
use std::io::{self, BufRead, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Read from stdin
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line.unwrap_or_else(|e| {
            eprintln!("rot13: {}", e);
            process::exit(1);
        });
        let rotated: String = line.chars().map(|c| match c {
            'a'..='m' | 'A'..='M' => (c as u8 + 13) as char,
            'n'..='z' | 'N'..='Z' => (c as u8 - 13) as char,
            _ => c,
        }).collect();
        writeln!(out, "{}", rotated).unwrap();
    }
}
```

### 2. Register the binary target

Add to `packages/coreutils/Cargo.toml`:

```toml
[[bin]]
name = "rot13"
path = "src/bin/rot13.rs"
```

### 3. Build

```bash
cargo build --target wasm32-wasip1 --release
```

Output: `target/wasm32-wasip1/release/rot13.wasm`

### 4. Deploy to fixture directories

```bash
cp target/wasm32-wasip1/release/rot13.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/
```

The sandbox auto-discovers `.wasm` files in the `wasmDir` directory. No registration code needed — just drop the file in.

### 5. Test

```bash
# Run the sandbox test suite
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

Or test interactively via the SDK:

```typescript
const sandbox = await Sandbox.create({ wasmDir: './path/to/fixtures' });
const result = await sandbox.run('echo "hello world" | rot13');
console.log(result.stdout); // "uryyb jbeyq\n"
```

## Standalone Command (Separate Crate)

For commands that need their own dependencies or more complex structure, create a separate crate:

```bash
mkdir -p packages/my-tool
cd packages/my-tool
cargo init --name my-tool
```

Add to the workspace in the root `Cargo.toml`:

```toml
[workspace]
members = [
  # ... existing members ...
  "packages/my-tool",
]
```

Build and deploy the same way:

```bash
cargo build --target wasm32-wasip1 --release -p my-tool
cp target/wasm32-wasip1/release/my-tool.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/
```

The command name is derived from the `.wasm` filename: `my-tool.wasm` → command `my-tool`.

## What Your Command Can Do

### File I/O

Read and write files in the sandbox's virtual filesystem:

```rust
use std::fs;

// Read a file
let content = fs::read_to_string("/home/user/data.txt").unwrap();

// Write a file
fs::write("/home/user/output.txt", "result").unwrap();

// List a directory
for entry in fs::read_dir("/home/user").unwrap() {
    println!("{}", entry.unwrap().path().display());
}
```

All paths are within the in-memory VFS. The command cannot access the host filesystem.

### Stdin / Stdout / Stderr

Standard I/O works normally. In pipelines, stdin/stdout are connected to pipes:

```rust
use std::io::{self, BufRead, Write};

// Read stdin line by line
let stdin = io::stdin();
for line in stdin.lock().lines() {
    let line = line.unwrap();
    // Process and write to stdout
    println!("{}", line.to_uppercase());
}
```

Use `BufWriter` for performance with many small writes:

```rust
use std::io::{self, BufWriter, Write};

let stdout = io::stdout();
let mut out = BufWriter::new(stdout.lock());
for i in 0..1000 {
    writeln!(out, "{}", i).unwrap();
}
```

### Environment Variables

```rust
use std::env;

let path = env::var("PATH").unwrap_or_default();
let home = env::var("HOME").unwrap_or_default();

// Iterate all env vars
for (key, value) in env::vars() {
    println!("{}={}", key, value);
}
```

### Command-Line Arguments

```rust
use std::env;

let args: Vec<String> = env::args().collect();
// args[0] = command name (e.g., "rot13")
// args[1..] = arguments passed by the user
```

### Exit Codes

```rust
use std::process;

// Success
process::exit(0);

// Error
eprintln!("my-tool: something went wrong");
process::exit(1);
```

## What Your Command Cannot Do

| Capability | Status | Reason |
|-----------|--------|--------|
| Network access | No | WASI sockets not implemented |
| Spawn subprocesses | Not yet | Process management syscalls are shell-only (for now) |
| Multithreading | No | `wasm32-wasip1` is single-threaded |
| Host filesystem access | No | All I/O goes through the sandboxed VFS |
| Signals (SIGINT, etc.) | No | No signal delivery mechanism |

## Build Configuration

The workspace uses these release optimizations (`Cargo.toml` at root):

```toml
[profile.release]
lto = true          # link-time optimization
opt-level = "z"     # optimize for binary size
strip = true        # strip debug symbols
```

This keeps `.wasm` files small (typically 50KB–500KB per tool).

### Dependencies

Coreutils commands share the workspace dependencies:

```toml
[dependencies]
flate2 = { version = "1.0", default-features = false, features = ["rust_backend"] }
regex = { version = "1", default-features = false, features = ["std", "unicode-perl", "unicode-case"] }
tar = "0.4"
```

Use `default-features = false` to minimize binary size. Avoid dependencies that require system libraries (OpenSSL, etc.) — they won't compile to WASI.

## Conventions

- **Error messages:** Write to stderr with the command name prefix: `eprintln!("mytool: error message");`
- **Exit codes:** 0 = success, 1 = general error, 2 = usage error (matches GNU conventions)
- **Flags:** Support both short (`-n`) and long (`--number`) forms where practical
- **Stdin handling:** If no file arguments are given, read from stdin (like `cat`, `grep`, `wc`)
- **Binary names:** Use lowercase, hyphen-separated names. The `.wasm` filename becomes the command name.

## File Summary

| Path | Purpose |
|------|---------|
| `packages/coreutils/Cargo.toml` | Coreutils crate — add `[[bin]]` entries here |
| `packages/coreutils/src/bin/` | One `.rs` file per command |
| `Cargo.toml` (root) | Workspace config — add standalone crates to `members` |
| `target/wasm32-wasip1/release/` | Build output — `.wasm` binaries |
| `packages/orchestrator/src/platform/__tests__/fixtures/` | Test fixtures — drop `.wasm` files here |
| `scripts/copy-wasm.sh` | Copies fixtures to packaging directory |
