# Document Command Compatibility — Implementation Plan

**Goal:** Add sandbox-native document commands with familiar real-world CLI surfaces: `pdfinfo`, `pdfunite`, `pdfseparate`, `xlsx2csv`, and `csv2xlsx`.

**Architecture:** Two standalone Rust workspace crates compiled to `wasm32-wasip1` and copied into the sandbox wasm bundle. One crate owns PDF commands, one crate owns spreadsheet commands.

**Tech Stack:** Rust, WASI Preview 1, `lopdf`, `calamine`, `rust_xlsxwriter`.

**Spec:** `docs/superpowers/specs/2026-03-20-document-command-compat-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `Cargo.toml` | Modify | Add new workspace members |
| `packages/pdf-tools/Cargo.toml` | Create | PDF command crate manifest |
| `packages/pdf-tools/src/lib.rs` | Create | Shared PDF helpers and exit-code mapping |
| `packages/pdf-tools/src/bin/pdfinfo.rs` | Create | `pdfinfo` implementation |
| `packages/pdf-tools/src/bin/pdfunite.rs` | Create | `pdfunite` implementation |
| `packages/pdf-tools/src/bin/pdfseparate.rs` | Create | `pdfseparate` implementation |
| `packages/xlsx-tools/Cargo.toml` | Create | Spreadsheet command crate manifest |
| `packages/xlsx-tools/src/lib.rs` | Create | Shared XLSX/CSV helpers |
| `packages/xlsx-tools/src/bin/xlsx2csv.rs` | Create | `xlsx2csv` implementation |
| `packages/xlsx-tools/src/bin/csv2xlsx.rs` | Create | `csv2xlsx` implementation |
| `packages/orchestrator/src/platform/__tests__/fixtures/` | Modify | Add built `.wasm` binaries |
| `scripts/build-document-tools.sh` | Create | Build and copy both crates' wasm outputs |
| `scripts/copy-wasm.sh` | Modify | Copy new wasm outputs into packaging targets |
| `packages/orchestrator/src/__tests__/document-tools.test.ts` | Create | Integration tests for command behavior |

---

## Phase 1: Workspace and crate scaffolding

- [ ] Add `packages/pdf-tools` and `packages/xlsx-tools` to the root workspace.
- [ ] Create both crate manifests with release-friendly dependency settings.
- [ ] Add a small shared helper module in each crate for:
  - usage text
  - exit-code mapping
  - stdout/stderr formatting
- [ ] Add a dedicated build script for these crates, similar to existing wasm build scripts.
- [ ] Update wasm-copy packaging so the new tools are included in MCP and SDK bundles.

Acceptance criteria:

- `cargo build --target wasm32-wasip1 -p pdf-tools -p xlsx-tools`
- `scripts/build-document-tools.sh` copies the resulting `.wasm` files into the fixture directory

---

## Phase 2: `pdfinfo`

- [ ] Implement positional parsing for `pdfinfo [options] [PDF-file]`.
- [ ] Support:
  - `-f`
  - `-l`
  - `-box`
  - `-meta`
  - `-isodates`
  - `-rawdates`
  - `-enc`
  - `-opw`
  - `-upw`
  - `-v`
  - `-h`, `-help`, `--help`
- [ ] Read metadata and page info with `lopdf`.
- [ ] Format output using Poppler-like field names.
- [ ] Map common failures to Poppler-like exit codes.

Acceptance criteria:

- `pdfinfo sample.pdf` prints stable key-value output including page count and PDF version
- `pdfinfo -meta sample.pdf` prints metadata-only output
- `pdfinfo -f 2 -l 3 sample.pdf` prints per-page size information for the requested pages

---

## Phase 3: `pdfunite`

- [ ] Implement `pdfunite [options] PDF-sourcefile1..PDF-sourcefilen PDF-destfile`.
- [ ] Support `-v`, `-h`, `-help`, `--help`.
- [ ] Merge source files in command-line order.
- [ ] Reject obviously invalid invocations:
  - fewer than two source PDFs
  - missing destination path
  - unreadable inputs

Acceptance criteria:

- `pdfunite a.pdf b.pdf out.pdf` creates a merged file
- merged page count equals the sum of inputs for normal fixtures
- invalid arity returns usage error

---

## Phase 4: `pdfseparate`

- [ ] Implement `pdfseparate [options] PDF-file PDF-page-pattern`.
- [ ] Support:
  - `-f`
  - `-l`
  - `-v`
  - `-h`, `-help`, `--help`
- [ ] Validate that the output page pattern contains `%d` or compatible printf formatting.
- [ ] Extract each requested page to a standalone PDF.

Acceptance criteria:

- `pdfseparate sample.pdf page-%d.pdf` writes one file per page
- `pdfseparate -f 2 -l 3 sample.pdf page-%d.pdf` writes only pages 2 and 3
- pattern validation failures return usage error

---

## Phase 5: `xlsx2csv`

- [ ] Implement `xlsx2csv [OPTIONS] EXCEL_WORKBOOK_NAME [SHEET_NAME]`.
- [ ] Support:
  - `-N`, `-sheets`
  - `-c`, `-count`
  - `-nl`, `-newline`
  - `-crlf`
  - `-o`, `-output`
  - `-quiet`
  - `-version`
  - `-help`
- [ ] Default to the first worksheet when no sheet name is provided.
- [ ] Convert worksheet rows to RFC 4180-style CSV.
- [ ] Preserve blank cells and row ordering as exposed by `calamine`.

Acceptance criteria:

- `xlsx2csv workbook.xlsx` converts the first sheet to stdout
- `xlsx2csv workbook.xlsx "Sheet 2"` converts the named sheet
- `xlsx2csv -count workbook.xlsx` prints the sheet count only
- `xlsx2csv -sheets workbook.xlsx` prints one sheet name per line

---

## Phase 6: `csv2xlsx`

- [ ] Implement:
  - `csv2xlsx -i data.csv MyWorkbook.xlsx 'My worksheet 1'`
  - `cat data.csv | csv2xlsx MyWorkbook.xlsx 'My worksheet 2'`
- [ ] Support:
  - `-i`
  - `-h`, `-help`, `--help`
  - `-v`, `-version`
- [ ] Parse CSV from file or stdin.
- [ ] Write one worksheet into one workbook with `rust_xlsxwriter`.
- [ ] Keep v1 semantics simple:
  - create/overwrite workbook
  - one sheet only
  - basic value writing, not formatting preservation

Acceptance criteria:

- `csv2xlsx -i data.csv out.xlsx Sheet1` creates a valid workbook
- `xlsx2csv out.xlsx Sheet1` round-trips the sheet data for normal fixtures
- missing worksheet name or workbook path returns usage error

---

## Phase 7: Tests and fixtures

- [ ] Add small PDF fixtures with known metadata and page counts.
- [ ] Add small XLSX fixtures with:
  - multiple sheets
  - empty cells
  - quoted strings
  - numeric values
  - booleans
- [ ] Add shell-level integration tests for:
  - `--help`
  - basic happy paths
  - common error cases
- [ ] Add golden output tests for:
  - `pdfinfo`
  - `xlsx2csv -count`
  - `xlsx2csv -sheets`

Acceptance criteria:

- `deno test -A --no-check packages/orchestrator/src/__tests__/document-tools.test.ts`

---

## Phase 8: Packaging and documentation

- [ ] Ensure `scripts/copy-wasm.sh` includes the new document commands.
- [ ] Ensure MCP and Python wheel packaging pull in the new wasm files.
- [ ] Add user-facing guide docs after command behavior is stable.
- [ ] Document any deliberate compatibility gaps in help text and docs.

Acceptance criteria:

- built MCP bundle contains the new wasm command binaries
- packaged Python bundle contains the new wasm command binaries

---

## Deliberate v1 exclusions

- `xlsxinfo`
- `pdftotext`
- DOCX commands
- PPTX commands
- multi-sheet `csv2xlsx`
- append/update workbook operations

These are excluded to keep the first implementation aligned with real, documented CLI surfaces and crates that already compile cleanly to `wasm32-wasip1`.
