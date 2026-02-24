# SQLite, bc, and dc Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `sqlite3`, `bc`, and `dc` as WASM tools in wasmsand so agents can query structured data and do precise arithmetic.

**Architecture:** `dc` and `bc` are Rust binaries added to `packages/coreutils` (existing pipeline). `sqlite3` is compiled from C using wasi-sdk in a new `packages/sqlite` package. All three register automatically via the existing glob-based discovery.

**Tech Stack:** Rust (bc/dc), C + wasi-sdk (sqlite3), wasm32-wasip1 target

---

## Task 1: Implement dc (RPN calculator)

**Files:**
- Create: `packages/coreutils/src/bin/dc.rs`
- Modify: `packages/coreutils/Cargo.toml` (add `[[bin]]` entry)

dc is a stack-based RPN calculator. It reads tokens from stdin. Each token is either a number (pushed onto the stack) or a command that operates on the stack.

**Step 1: Add bin entry to Cargo.toml**

Add to `packages/coreutils/Cargo.toml` after the last `[[bin]]` block:

```toml
[[bin]]
name = "dc"
path = "src/bin/dc.rs"
```

**Step 2: Write dc.rs**

Create `packages/coreutils/src/bin/dc.rs`. The implementation must support:

- **Numbers**: Push decimal numbers (including negatives with `_` prefix, e.g. `_5` for -5)
- **Arithmetic**: `+`, `-`, `*`, `/`, `%`, `^` (power), `v` (sqrt) — pop operands, push result
- **Stack**: `p` print top, `n` print top no newline and pop, `f` print entire stack, `c` clear, `d` duplicate top, `r` swap top two
- **Precision**: `k` set scale (decimal places), `K` push current scale
- **Base**: `i` set input radix, `o` set output radix, `I`/`O` push current bases
- **Registers**: `sa` store top in register `a`, `la` load from register `a` (any single char)
- **Strings**: `[text]` push string literal, `x` execute top as dc program
- **Comparison**: `=r`, `>r`, `<r`, `!= r`, `>=r`, `<=r` — compare top two, execute register if true
- **Misc**: `z` push stack depth, `Z` push digit count of top, `q` quit

Use `f64` for values (sufficient for a sandbox calculator — no need for arbitrary precision in dc). Read all of stdin, tokenize, execute sequentially.

Pattern: match the style of existing tools (e.g. `expr.rs`, `seq.rs`) — `use std::env`, `use std::io`, `use std::process`, read stdin, write to stdout/stderr.

**Step 3: Verify it compiles**

Run: `cargo check -p wasmsand-coreutils --bin dc`
Expected: compiles with no errors

**Step 4: Commit**

```bash
git add packages/coreutils/Cargo.toml packages/coreutils/src/bin/dc.rs
git commit -m "feat: add dc (RPN calculator) to coreutils"
```

---

## Task 2: Implement bc (infix calculator)

**Files:**
- Create: `packages/coreutils/src/bin/bc.rs`
- Modify: `packages/coreutils/Cargo.toml` (add `[[bin]]` entry)

bc is an infix calculator language. It reads expressions from stdin, evaluates them, and prints results.

**Step 1: Add bin entry to Cargo.toml**

Add to `packages/coreutils/Cargo.toml`:

```toml
[[bin]]
name = "bc"
path = "src/bin/bc.rs"
```

**Step 2: Write bc.rs**

Create `packages/coreutils/src/bin/bc.rs`. The implementation must support:

**Core features:**
- Arithmetic: `+`, `-`, `*`, `/`, `%`, `^` with standard precedence
- Parentheses for grouping
- Variables: lowercase single letters `a` through `z` (POSIX bc uses single-letter variables)
- Special variables: `scale` (decimal precision, default 0), `ibase` (input base, default 10), `obase` (output base, default 10), `last` (last printed value)
- Assignment: `var = expr`, compound: `+=`, `-=`, `*=`, `/=`, `%=`, `^=`
- Increment/decrement: `++var`, `--var`, `var++`, `var--`
- Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=` (return 0 or 1)
- Boolean: `!`, `&&`, `||`

**Control flow:**
- `if (cond) { stmts }` with optional `else { stmts }`  — note: POSIX bc has no else, but GNU bc does; include it
- `while (cond) { stmts }`
- `for (init; cond; update) { stmts }`
- `break`, `continue`, `halt`, `quit`

**Functions:**
- `define name(params) { body; return expr }` — auto variables via `auto` keyword
- `length(expr)` — number of significant digits
- `sqrt(expr)` — square root
- `read()` — read a number from stdin (for interactive use)

**Math library (`-l` flag):**
When `-l` is passed, `scale` defaults to 20 and these functions are available:
- `s(x)` sine, `c(x)` cosine, `a(x)` arctangent, `l(x)` natural log, `e(x)` exponential, `j(n,x)` Bessel function

**Implementation approach:**
- Tokenizer: lex into Number, Ident, String, Op, Keyword tokens
- Parser: recursive-descent, produces AST
- Evaluator: tree-walk interpreter
- Use `f64` for values (same rationale as dc — sandbox calculator, not a math library)
- `-l` math functions: use `f64` methods (`f64::sin`, `f64::cos`, etc.)
- Read from stdin, print each expression result that isn't an assignment

**Step 3: Verify it compiles**

Run: `cargo check -p wasmsand-coreutils --bin bc`
Expected: compiles with no errors

**Step 4: Commit**

```bash
git add packages/coreutils/Cargo.toml packages/coreutils/src/bin/bc.rs
git commit -m "feat: add bc (infix calculator) to coreutils"
```

---

## Task 3: Build dc and bc to WASM, add to fixtures

**Files:**
- Modify: `scripts/build-coreutils.sh` (add `bc dc` to TOOLS array)

**Step 1: Add bc and dc to build script tool list**

In `scripts/build-coreutils.sh`, line 33, add `bc dc` to the TOOLS array:

```bash
TOOLS=(cat echo head tail wc sort uniq grep ls mkdir rm cp mv touch tee tr cut basename dirname env printf find sed awk jq du df gzip tar bc dc)
```

**Step 2: Build WASM binaries**

Run: `./scripts/build-coreutils.sh --copy-fixtures`
Expected: Builds successfully, copies `bc.wasm` and `dc.wasm` to test fixtures

**Step 3: Verify fixtures exist**

Run: `ls -la packages/orchestrator/src/platform/__tests__/fixtures/{bc,dc}.wasm`
Expected: Both files exist

**Step 4: Commit the .wasm fixtures**

```bash
git add packages/orchestrator/src/platform/__tests__/fixtures/bc.wasm
git add packages/orchestrator/src/platform/__tests__/fixtures/dc.wasm
git add scripts/build-coreutils.sh
git commit -m "build: add bc and dc WASM binaries to fixtures"
```

---

## Task 4: Write dc integration tests

**Files:**
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Step 1: Register dc in the test TOOLS array**

In `coreutils.test.ts`, add `'dc'` to the `TOOLS` array (line ~29, after `'tar'`).

**Step 2: Write dc test suite**

Add a new `describe('dc', ...)` block in the `Coreutils Integration` suite:

```typescript
describe('dc', () => {
  it('basic arithmetic', async () => {
    const r = await runner.run('echo "3 4 + p" | dc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('7');
  });

  it('multiplication and subtraction', async () => {
    const r = await runner.run('echo "5 3 * 2 - p" | dc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('13');
  });

  it('division with scale', async () => {
    const r = await runner.run('echo "2 k 10 3 / p" | dc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('3.33');
  });

  it('stack operations', async () => {
    const r = await runner.run('echo "1 2 3 f" | dc');
    expect(r.exitCode).toBe(0);
    // f prints stack top-to-bottom
    const lines = r.stdout.trim().split('\n');
    expect(lines).toEqual(['3', '2', '1']);
  });

  it('duplicate and swap', async () => {
    const r = await runner.run('echo "5 d + p" | dc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('10');
  });

  it('registers store and load', async () => {
    const r = await runner.run('echo "42 sa la p" | dc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('42');
  });

  it('power and sqrt', async () => {
    const r = await runner.run('echo "2 10 ^ p" | dc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1024');
  });
});
```

**Step 3: Run tests**

Run: `bun test packages/orchestrator/src/shell/__tests__/coreutils.test.ts -t "dc"`
Expected: All dc tests pass

**Step 4: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "test: add dc integration tests"
```

---

## Task 5: Write bc integration tests

**Files:**
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Step 1: Register bc in the test TOOLS array**

Add `'bc'` to the `TOOLS` array in `coreutils.test.ts`.

**Step 2: Write bc test suite**

```typescript
describe('bc', () => {
  it('basic arithmetic', async () => {
    const r = await runner.run('echo "3 + 4" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('7');
  });

  it('operator precedence', async () => {
    const r = await runner.run('echo "2 + 3 * 4" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('14');
  });

  it('parentheses', async () => {
    const r = await runner.run('echo "(2 + 3) * 4" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('20');
  });

  it('scale for division', async () => {
    const r = await runner.run('echo "scale=2; 10/3" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('3.33');
  });

  it('variables', async () => {
    const r = await runner.run('echo "x=5; x*3" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('15');
  });

  it('power operator', async () => {
    const r = await runner.run('echo "2^10" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1024');
  });

  it('multiline program', async () => {
    const prog = 'x=10\\ny=20\\nx+y';
    const r = await runner.run(`printf "${prog}" | bc`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('30');
  });

  it('math library with -l', async () => {
    // e(1) should give Euler's number ~2.71828...
    const r = await runner.run('echo "e(1)" | bc -l');
    expect(r.exitCode).toBe(0);
    const val = parseFloat(r.stdout.trim());
    expect(val).toBeCloseTo(Math.E, 4);
  });

  it('comparison operators', async () => {
    const r = await runner.run('echo "3 > 2" | bc');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });

  it('user-defined function', async () => {
    const prog = 'define double(x) { return 2*x; }\\ndouble(21)';
    const r = await runner.run(`printf "${prog}" | bc`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('42');
  });
});
```

**Step 3: Run tests**

Run: `bun test packages/orchestrator/src/shell/__tests__/coreutils.test.ts -t "bc"`
Expected: All bc tests pass

**Step 4: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "test: add bc integration tests"
```

---

## Task 6: Set up SQLite wasi-sdk build

**Files:**
- Create: `packages/sqlite/Makefile`
- Modify: `Makefile` (add `build-sqlite` target)

**Step 1: Create packages/sqlite/Makefile**

```makefile
# Build SQLite to wasm32-wasi using wasi-sdk
#
# Prerequisites: wasi-sdk installed (brew install wasi-sdk or download from
# https://github.com/WebAssembly/wasi-sdk/releases)
#
# The WASI_SDK_PATH variable must point to the wasi-sdk installation.
# Common locations:
#   macOS (Homebrew): /opt/homebrew/opt/wasi-sdk/share/wasi-sdk
#   Linux: /opt/wasi-sdk

SQLITE_VERSION := 3490100
SQLITE_YEAR := 2025
SQLITE_URL := https://www.sqlite.org/$(SQLITE_YEAR)/sqlite-amalgamation-$(SQLITE_VERSION).zip

WASI_SDK_PATH ?= $(shell brew --prefix wasi-sdk 2>/dev/null)/share/wasi-sdk
CC := $(WASI_SDK_PATH)/bin/clang
SYSROOT := $(WASI_SDK_PATH)/share/wasi-sysroot

REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures

CFLAGS := \
	--sysroot=$(SYSROOT) \
	--target=wasm32-wasi \
	-O2 \
	-DSQLITE_THREADSAFE=0 \
	-DSQLITE_OMIT_WAL \
	-DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_OMIT_DEPRECATED \
	-DSQLITE_DEFAULT_LOCKING_MODE=1 \
	-DSQLITE_DQS=0

.PHONY: all clean copy-fixtures

all: sqlite3.wasm

# Download and extract SQLite amalgamation
src/sqlite3.c:
	mkdir -p src
	curl -sL $(SQLITE_URL) -o src/sqlite.zip
	cd src && unzip -o sqlite.zip
	mv src/sqlite-amalgamation-$(SQLITE_VERSION)/* src/
	rmdir src/sqlite-amalgamation-$(SQLITE_VERSION)
	rm src/sqlite.zip

sqlite3.wasm: src/sqlite3.c
	$(CC) $(CFLAGS) -o $@ src/shell.c src/sqlite3.c

copy-fixtures: sqlite3.wasm
	cp sqlite3.wasm $(FIXTURES)/sqlite3.wasm

clean:
	rm -rf src sqlite3.wasm
```

**Step 2: Add build-sqlite to root Makefile**

In the root `Makefile`, add a `build-sqlite` target and update the `build` target:

Change the `build` line from:
```makefile
build: build-rust build-ts
```
to:
```makefile
build: build-rust build-sqlite build-ts

build-sqlite:
	cd packages/sqlite && make
```

**Step 3: Verify wasi-sdk is available**

Run: `brew list wasi-sdk 2>/dev/null || echo "wasi-sdk not installed"`

If not installed: `brew install wasi-sdk`

**Step 4: Build SQLite**

Run: `cd packages/sqlite && make`
Expected: Downloads amalgamation, compiles, produces `sqlite3.wasm`

**Step 5: Copy to fixtures**

Run: `cd packages/sqlite && make copy-fixtures`
Expected: `sqlite3.wasm` copied to test fixtures

**Step 6: Verify**

Run: `ls -la packages/orchestrator/src/platform/__tests__/fixtures/sqlite3.wasm`
Expected: File exists, roughly 800KB-1.5MB

**Step 7: Commit**

```bash
git add packages/sqlite/Makefile
git add packages/orchestrator/src/platform/__tests__/fixtures/sqlite3.wasm
git add Makefile
git commit -m "feat: add SQLite wasi-sdk build, sqlite3.wasm binary"
```

---

## Task 7: Write SQLite integration tests

**Files:**
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Step 1: Register sqlite3 in the test TOOLS array**

Add `'sqlite3'` to the `TOOLS` array in `coreutils.test.ts`.

**Step 2: Write sqlite3 test suite**

```typescript
describe('sqlite3', () => {
  it('creates table and inserts data', async () => {
    const sql = 'CREATE TABLE t(id INTEGER, name TEXT); INSERT INTO t VALUES(1,"alice"); SELECT * FROM t;';
    const r = await runner.run(`echo "${sql}" | sqlite3`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('alice');
  });

  it('uses a database file', async () => {
    const create = await runner.run(
      'echo "CREATE TABLE nums(v INTEGER); INSERT INTO nums VALUES(42);" | sqlite3 /tmp/test.db'
    );
    expect(create.exitCode).toBe(0);
    const query = await runner.run('echo "SELECT v FROM nums;" | sqlite3 /tmp/test.db');
    expect(query.exitCode).toBe(0);
    expect(query.stdout.trim()).toBe('42');
  });

  it('supports CSV mode', async () => {
    const sql = 'CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2); INSERT INTO t VALUES(3,4); .mode csv\\nSELECT * FROM t;';
    const r = await runner.run(`printf "${sql}" | sqlite3`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1,2');
  });

  it('handles aggregations', async () => {
    const sql = 'CREATE TABLE n(v); INSERT INTO n VALUES(10); INSERT INTO n VALUES(20); INSERT INTO n VALUES(30); SELECT SUM(v), AVG(v) FROM n;';
    const r = await runner.run(`echo "${sql}" | sqlite3`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('60');
  });
});
```

**Step 3: Run tests**

Run: `bun test packages/orchestrator/src/shell/__tests__/coreutils.test.ts -t "sqlite3"`
Expected: All sqlite3 tests pass

Note: SQLite may need adjustments depending on how it handles WASI file I/O. If tests fail with file-related errors, we may need to tweak compile flags or add `sqlite3` to `CREATION_COMMANDS` in `shell-runner.ts` for database file path resolution.

**Step 4: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "test: add sqlite3 integration tests"
```

---

## Task 8: Register tools in browser adapter and run full test suite

**Files:**
- Modify: `packages/orchestrator/src/platform/browser-adapter.ts` (add to BROWSER_TOOLS)

**Step 1: Add tools to BROWSER_TOOLS**

In `packages/orchestrator/src/platform/browser-adapter.ts`, add `'bc'`, `'dc'`, `'sqlite3'` to the `BROWSER_TOOLS` array.

**Step 2: Run the full test suite**

Run: `bun test packages/orchestrator packages/sdk-server`
Expected: All tests pass (720+ existing tests plus new bc/dc/sqlite3 tests)

**Step 3: Commit**

```bash
git add packages/orchestrator/src/platform/browser-adapter.ts
git commit -m "feat: register bc, dc, sqlite3 in browser adapter"
```

---

## Task 9: Final verification and squash

**Step 1: Build TypeScript**

Run: `cd packages/orchestrator && bun run build`
Expected: Clean build

**Step 2: Run full test suite one more time**

Run: `bun test packages/orchestrator packages/sdk-server`
Expected: All pass

**Step 3: Push and verify CI**

Push the branch and confirm CI passes.
