# Document Command Compatibility

Add sandbox-native document conversion and inspection commands as `wasm32-wasip1` executables, with command-line surfaces modeled after established real-world tools rather than invented interfaces.

## Goal

Ship a first batch of document-focused commands that LLMs and users can discover and use with familiar names and mostly familiar flags:

- `pdfinfo`
- `pdfunite`
- `pdfseparate`
- `xlsx2csv`
- `csv2xlsx`

The compatibility target is "close enough to be intuitively usable if you know the real tool", not byte-for-byte output matching.

## Background

The sandbox already supports native Rust/WASM executables and auto-discovers them from the configured `wasmDir`. That is the correct integration point for document tooling: the commands should behave like `awk`, `sed`, `jq`, and the other sandbox-native tools, not like host extensions.

The crate feasibility pass against this repo's actual `wasm32-wasip1` toolchain produced a clean split:

- Viable now:
  - `lopdf` for PDF inspection/manipulation
  - `pdf-writer` for PDF generation/serialization
  - `calamine` for XLSX/XLS/XLSB/ODS reading
  - `rust_xlsxwriter` for XLSX writing
- Not viable as first targets:
  - `docx` pulled in `bzip2-sys` and failed to compile to `wasm32-wasip1`
  - `ppt-rs` pulled in `bzip2-sys` / `zstd-sys` / native assembly-heavy paths and failed to compile

This means PDF and spreadsheet commands are the right first wave. DOCX/PPTX should be deferred until a cleaner pure-Rust dependency path is available.

## Non-goals

- No host-backed extension wrappers
- No attempt to clone every Poppler/Xpdf tool
- No OCR, rendering, rasterization, or browser/HTML pipeline in this phase
- No `xlsxinfo` command in v1 unless we later decide to add it as a convenience wrapper

`xlsxinfo` is intentionally excluded from v1 because there does not appear to be a single dominant real CLI with that surface. For spreadsheets, the established compatibility targets are `xlsx2csv` and `csv2xlsx`.

## Scope

### PDF commands

#### 1. `pdfinfo`

Compatibility target: Poppler/Xpdf `pdfinfo`.

V1 behavior:

- Read one PDF file and print document metadata plus summary information
- Support page-range-aware page size reporting
- Support a subset of real `pdfinfo` flags with the same names and meanings where feasible

V1 flags:

- `-f <number>`
- `-l <number>`
- `-box`
- `-meta`
- `-isodates`
- `-rawdates`
- `-enc <encoding-name>`
- `-opw <password>`
- `-upw <password>`
- `-v`
- `-h`, `-help`, `--help`

Deferred flags:

- `-js`
- `-struct`
- `-struct-text`
- `-dests`
- `-listenc`

Rationale:

- `lopdf` can supply the core metadata, page count, encryption flag, PDF version, page boxes, and catalog metadata needed for a useful `pdfinfo`.
- JavaScript extraction, structure tree rendering, and named destination listings are lower-value for the first cut and add more implementation surface than they buy.

Expected output shape:

- Keep the familiar key-value layout used by Poppler, e.g. `Title:`, `Author:`, `Pages:`, `Encrypted:`, `Page size:`, `PDF version:`
- Field names should match Poppler where practical
- Output does not need to preserve spacing width exactly

Exit codes:

- Match Poppler/Xpdf conventions where practical:
  - `0` success
  - `1` input/open error
  - `2` output error
  - `3` permission/password error
  - `99` other error

#### 2. `pdfunite`

Compatibility target: Poppler `pdfunite`.

V1 behavior:

- Merge two or more source PDFs into one destination PDF
- Preserve source order from the command line

V1 flags:

- `-v`
- `-h`, `-help`, `--help`

Behavior constraints:

- Reject fewer than two input PDFs
- Reject encrypted PDFs in v1 unless password support is straightforward and low-risk
- Destination path is required and must be last positional argument

#### 3. `pdfseparate`

Compatibility target: Poppler `pdfseparate`.

V1 behavior:

- Extract one or more pages from a source PDF into one output file per page
- Require a printf-style page pattern containing `%d`

V1 flags:

- `-f <number>`
- `-l <number>`
- `-v`
- `-h`, `-help`, `--help`

Behavior constraints:

- If `-f` is omitted, start at page 1
- If `-l` is omitted, end at the last page
- If the output pattern does not contain `%d` (or equivalent), return usage error

### Spreadsheet commands

#### 4. `xlsx2csv`

Compatibility target: the documented `xlsx2csv` CLI from Caltech Library datatools.

V1 behavior:

- Convert one workbook sheet to CSV
- If no sheet is provided, convert the first sheet
- Allow listing sheet names and sheet count without converting cell data

V1 flags:

- `-N`, `-sheets`
- `-c`, `-count`
- `-nl`, `-newline`
- `-crlf`
- `-o <path>`, `-output <path>`
- `-quiet`
- `-version`
- `-help`

Positional arguments:

- `EXCEL_WORKBOOK_NAME`
- optional `SHEET_NAME`

Behavior notes:

- Use workbook sheet order as exposed by `calamine`
- When a sheet name is provided, match by exact sheet name
- CSV output should use a standard comma delimiter and RFC 4180-style quoting
- `-o -` should mean stdout

Deferred behavior:

- Alternate delimiters
- Sheet-by-index selection
- Multi-sheet export in one invocation

Rationale:

- The datatools man page is concise, explicit, and maps cleanly onto `calamine`
- A focused single-sheet converter is more compatible and easier to reason about than inventing a workbook export DSL

#### 5. `csv2xlsx`

Compatibility target: the documented `csv2xlsx` command shape from Caltech Library datatools, using `rust_xlsxwriter` underneath.

V1 behavior:

- Create or overwrite an `.xlsx` workbook from CSV input
- Support file input via `-i <csv>` or stdin piping
- Write into a specified workbook path and worksheet name

V1 interface:

- `csv2xlsx -i data.csv MyWorkbook.xlsx 'My worksheet 1'`
- `cat data.csv | csv2xlsx MyWorkbook.xlsx 'My worksheet 2'`

V1 flags:

- `-i <path>`
- `-h`, `-help`, `--help`
- `-v`, `-version`

Behavior notes:

- Exactly one worksheet per generated workbook in v1
- Workbook path is required
- Worksheet name is required
- If both `-i` and stdin data are absent, return usage error
- If both are present, `-i` wins

Deferred behavior:

- Appending additional sheets to an existing workbook
- Multi-CSV to multi-sheet import in one invocation
- Delimiter overrides
- Type inference beyond basic numeric / boolean / string detection

Rationale:

- `rust_xlsxwriter` writes modern `.xlsx` cleanly to WASI
- Single-sheet generation avoids ambiguity and is enough to support common agent workflows

## Packaging

Use standalone workspace crates, not `packages/coreutils`.

Why:

- These commands have domain-specific dependencies much larger than normal coreutils
- Isolating them keeps compile times, binary ownership, and future maintenance clearer
- The repo already supports standalone command crates as first-class sandbox executables

Proposed crates:

- `packages/pdf-tools`
  - bins: `pdfinfo`, `pdfunite`, `pdfseparate`
- `packages/xlsx-tools`
  - bins: `xlsx2csv`, `csv2xlsx`

## Implementation outline

### `packages/pdf-tools`

Dependencies:

- `lopdf`
- `pdf-writer` only if needed for clean page serialization paths not handled directly by `lopdf`

Internal modules:

- `src/lib.rs`
  - argument parsing helpers
  - shared error / exit-code mapping
  - metadata formatting helpers
- `src/bin/pdfinfo.rs`
- `src/bin/pdfunite.rs`
- `src/bin/pdfseparate.rs`

### `packages/xlsx-tools`

Dependencies:

- `calamine`
- `rust_xlsxwriter`

Internal modules:

- `src/lib.rs`
  - workbook/sheet selection helpers
  - CSV quoting/writing helpers
  - shared usage/error formatting
- `src/bin/xlsx2csv.rs`
- `src/bin/csv2xlsx.rs`

## Testing

### Command compatibility tests

Add shell-level integration tests that assert:

- `--help` / `-help` / `-h` surfaces and usage lines match the intended command family
- common flags parse correctly
- output shape is stable enough for agent use

### Fixture-based behavior tests

Add small fixtures for:

- PDF metadata inspection
- PDF merge
- PDF page extraction
- XLSX with multiple sheets
- XLSX with empty cells, quoted cells, numbers, booleans
- CSV to XLSX round-trip

### Golden output tests

Use golden outputs for:

- `pdfinfo` default output
- `pdfinfo -meta`
- `xlsx2csv -count`
- `xlsx2csv -sheets`

The golden tests should validate field names and line structure, not every byte of spacing.

## Risks

### 1. `pdfinfo` output drift

Risk:

- Poppler has accumulated a fairly specific output vocabulary; LLMs may expect those labels.

Mitigation:

- Reuse Poppler field names directly where possible
- Snapshot-test representative outputs

### 2. PDF save/merge edge cases

Risk:

- Merging and page extraction can break PDFs with unusual object graphs, forms, or encryption.

Mitigation:

- Keep v1 focused on ordinary unencrypted PDFs
- Return explicit unsupported/permission errors rather than silently producing broken output

### 3. XLSX typing surprises

Risk:

- Spreadsheet readers/writers often blur strings, numbers, dates, and formulas.

Mitigation:

- Document the v1 behavior as value-oriented rather than formatting-oriented
- Prefer stable CSV serialization over aggressive type inference

## Open questions

1. Should `pdfinfo` implement `-listenc` in v1 by printing a short fixed list such as `UTF-8`, or should it remain unsupported until there is a real encoding backend story?
2. Should `csv2xlsx` accept an omitted worksheet name and default to `Sheet1`, or should it require the worksheet name to stay aligned with the documented examples?
3. Do we want a later convenience command like `xlsxinfo`, even though it is not a standard compatibility target?

## Sources

- [pdfinfo(1) man page](https://manpages.debian.org/buster/poppler-utils/pdfinfo.1.en.html)
- [pdfunite(1) man page](https://manpages.debian.org/testing/poppler-utils/pdfunite.1.en.html)
- [pdfseparate(1) man page](https://manpages.debian.org/unstable/poppler-utils/pdfseparate.1.en.html)
- [xlsx2csv man page](https://caltechlibrary.github.io/datatools/xlsx2csv.1.html)
- [Using csv2xlsx](https://caltechlibrary.github.io/datatools/how-to/csv2xlsx.html)
- [XLSX I/O project page](https://brechtsanders.github.io/xlsxio/)
