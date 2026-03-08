# Creating Executables

This guide explains how to create new executables that run inside the codepod sandbox. Executables are Rust binaries compiled to WebAssembly (WASI P1) and spawned as isolated processes by the sandbox's process kernel.

## How it works

Every executable runs as its own WASM process. The kernel provides standard POSIX-like I/O:

```
stdin  = fd 0    (pipe from previous pipeline stage, or input redirect)
stdout = fd 1    (pipe to next pipeline stage, or capture buffer)
stderr = fd 2    (capture buffer, or merged with stdout via 2>&1)
```

Your code links against standard Rust libraries. The WASI layer maps them to the sandbox kernel:

| Rust stdlib | WASI syscall | Kernel provides |
|-------------|-------------|-----------------|
| `std::io::stdin()` | `fd_read(0, ...)` | Pipe from previous stage, redirect content, or /dev/null |
| `std::io::stdout()` | `fd_write(1, ...)` | Pipe to next stage, or capture buffer |
| `std::io::stderr()` | `fd_write(2, ...)` | Capture buffer (or stdout pipe if 2>&1) |
| `std::fs::File::open()` | `path_open(...)` | In-memory VFS |
| `std::env::args()` | `args_get(...)` | Arguments from the shell |
| `std::env::var()` | `environ_get(...)` | Environment from the shell |
| `std::process::exit()` | `proc_exit(...)` | Reports exit code to caller |

You don't need to know about WASI, pipes, or the kernel. Write normal Rust.

## Quick Start: Add to Coreutils

All standard executables live in `packages/coreutils/` as binary targets in a single Cargo workspace crate.

### 1. Create the source file

```bash
# Example: adding a 'rot13' executable
touch packages/coreutils/src/bin/rot13.rs
```

Write standard Rust:

```rust
use std::io::{self, BufRead, Write};

fn main() {
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in io::stdin().lock().lines() {
        let line = line.unwrap_or_else(|e| {
            eprintln!("rot13: {}", e);
            std::process::exit(1);
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

The sandbox auto-discovers `.wasm` files in the `wasmDir` directory. No registration code needed — just drop the file in. Each discovered tool is automatically registered as a special file in `/usr/bin/` with the `S_TOOL` flag (see [Security](./security.md#tool-file-integrity)).

### 5. Test

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

Or test interactively via the SDK:

```typescript
const sandbox = await Sandbox.create({ wasmDir: './path/to/fixtures' });
const result = await sandbox.run('echo "hello world" | rot13');
console.log(result.stdout); // "uryyb jbeyq\n"
```

## Standalone Executable (Separate Crate)

For executables that need their own dependencies or more complex structure, create a separate crate:

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

The command name is derived from the `.wasm` filename: `my-tool.wasm` -> command `my-tool`.

### Command aliases via symlinks

To create a command alias, use a VFS symlink. For example, `python` is a built-in symlink to `python3`:

```
/usr/bin/python → /usr/bin/python3   (symlink, created at init)
/usr/bin/python3                      (tool file, S_TOOL flag set)
```

The resolver follows symlinks through the VFS, reads the target tool file, and verifies the `S_TOOL` flag. This means standard `ln -s` semantics apply — no special aliasing API needed.

## What Your Executable Can Do

### File I/O

Read and write files in the sandbox's virtual filesystem:

```rust
use std::fs;

let content = fs::read_to_string("/home/user/data.txt").unwrap();
fs::write("/home/user/output.txt", "result").unwrap();

for entry in fs::read_dir("/home/user").unwrap() {
    println!("{}", entry.unwrap().path().display());
}
```

All paths are within the in-memory VFS. The executable cannot access the host filesystem.

### Stdin / Stdout / Stderr

Standard I/O works normally. In pipelines, stdin/stdout are connected to pipes:

```rust
use std::io::{self, BufRead, Write};

for line in io::stdin().lock().lines() {
    let line = line.unwrap();
    println!("{}", line.to_uppercase());
}
```

Use `BufWriter` for performance with many small writes:

```rust
use std::io::{self, BufWriter, Write};

let mut out = BufWriter::new(io::stdout().lock());
for i in 0..1000 {
    writeln!(out, "{}", i).unwrap();
}
```

### Environment Variables

```rust
use std::env;

let path = env::var("PATH").unwrap_or_default();
for (key, value) in env::vars() {
    println!("{}={}", key, value);
}
```

### Command-Line Arguments

```rust
let args: Vec<String> = std::env::args().collect();
// args[0] = command name (e.g., "rot13")
// args[1..] = arguments passed by the user
```

### Exit Codes

```rust
// Success (implicit — just return from main)

// Error
eprintln!("my-tool: something went wrong");
std::process::exit(1);
```

## What Your Executable Cannot Do

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

This keeps `.wasm` files small (typically 50KB-500KB per executable).

### Dependencies

Coreutils executables share the workspace dependencies:

```toml
[dependencies]
flate2 = { version = "1.0", default-features = false, features = ["rust_backend"] }
regex = { version = "1", default-features = false, features = ["std", "unicode-perl", "unicode-case"] }
tar = "0.4"
```

Use `default-features = false` to minimize binary size. Avoid dependencies that require system libraries (OpenSSL, etc.) — they won't compile to WASI.

## Conventions

- **Error messages:** Write to stderr with the executable name prefix: `eprintln!("mytool: error message");`
- **Exit codes:** 0 = success, 1 = general error, 2 = usage error (matches GNU conventions)
- **Flags:** Support both short (`-n`) and long (`--number`) forms where practical
- **Stdin handling:** If no file arguments are given, read from stdin (like `cat`, `grep`, `wc`)
- **Binary names:** Use lowercase, hyphen-separated names. The `.wasm` filename becomes the command name.

## File Summary

| Path | Purpose |
|------|---------|
| `packages/coreutils/Cargo.toml` | Coreutils crate — add `[[bin]]` entries here |
| `packages/coreutils/src/bin/` | One `.rs` file per executable |
| `Cargo.toml` (root) | Workspace config — add standalone crates to `members` |
| `target/wasm32-wasip1/release/` | Build output — `.wasm` binaries |
| `packages/orchestrator/src/platform/__tests__/fixtures/` | Test fixtures — drop `.wasm` files here |
| `scripts/copy-wasm.sh` | Copies fixtures to packaging directory |
