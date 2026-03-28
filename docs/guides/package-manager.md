# Package Manager

codepod has two package managers, each covering a different type of extension:

| Command | Installs | Source |
|---------|----------|--------|
| `pkg install <name>` | WASI binary tools (new shell commands) | [codepod-packages registry](#codepod-packages-registry) |
| `pip install <name>` | Python packages | [codepod pip registry](#codepod-pip-registry) |

Both managers install into the sandbox VFS. Installed packages are sandboxed with the same security boundary as built-in coreutils and the Python standard library.

---

## pkg — WASI binary tools

`pkg` installs WASM-compiled tools that become available as shell commands.

### Setup

The package manager is **disabled by default**. Enable it with `packagePolicy.enabled: true`:

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  security: {
    packagePolicy: {
      enabled: true,
      // Optional: restrict to the official registry only
      allowedHosts: ['codepod-sandbox.github.io'],
      maxPackageBytes: 5 * 1024 * 1024,
      maxInstalledPackages: 50,
    },
  },
});
```

### Usage

```bash
# Install a named package from the official registry
pkg install pdftotext

# Install directly from a URL
pkg install https://example.com/mytool.wasm

# List installed packages
pkg list

# Remove a package
pkg remove pdftotext
```

```python
with Sandbox() as sb:
    sb.commands.run("pkg install pdftotext")
    sb.commands.run("pdftotext document.pdf -")
    sb.commands.run("pkg list")
    sb.commands.run("pkg remove pdftotext")
```

**Note:** Package policy is set at the TypeScript orchestrator level. The Python SDK inherits the policy (disabled by default).

### codepod-packages registry

Named packages (e.g. `pkg install pdftotext`) are resolved from the official registry:

```
https://codepod-sandbox.github.io/packages
```

Source: [`codepod-sandbox/packages`](https://github.com/codepod-sandbox/packages) on GitHub.

The registry serves a `pkg-index.json` manifest listing available packages and their tool entries. Override the registry URL with the `CODEPOD_REGISTRY` environment variable inside the sandbox:

```bash
export CODEPOD_REGISTRY=https://my-internal-registry.example.com
pkg install mytool
```

**Available packages:**

| Package | Tools | Description |
|---------|-------|-------------|
| `pdftotext` | `pdftotext` | Extract text from PDF files (Poppler-compatible) |
| `pdf-tools` | `pdfinfo`, `pdftotext`, `pdfunite`, `pdfseparate` | Full PDF manipulation suite |
| `sqlite3` | `sqlite3` | SQLite database engine |
| `ripgrep` | `rg` | Fast regex search |
| `sips` | `sips` | Image processing (resize, convert, rotate) |
| `xlsx-tools` | `xlsx2csv`, `csv2xlsx` | Excel spreadsheet conversion |

Note: `pdf-tools`, `sqlite3`, `sips`, and `xlsx-tools` are also built-in — they're available in all sandboxes without `pkg install`. `pkg install` provides on-demand installation for environments where binary size matters.

### Policy options

| Option | Description |
|--------|-------------|
| `enabled` | Whether installation is enabled (default: `false`) |
| `allowedHosts` | Allowed source hosts. Supports wildcards (`*.example.com`). If unset, any host is allowed when `enabled: true`. |
| `maxPackageBytes` | Maximum size in bytes for a single package |
| `maxInstalledPackages` | Maximum number of installed packages |

### Security

- Packages are fetched from allowed hosts only — enforced before download
- Package names are validated to prevent path traversal
- Installed WASI binaries run inside the same sandbox as built-in coreutils — no additional host access
- Packages are stored in the VFS at `/usr/share/pkg/bin/<name>.wasm`

See [Security Architecture](security.md#package-manager-security) for details.

---

## pip — Python packages

`pip install` installs Python packages from the codepod pip registry into the sandbox VFS. This is not PyPI — only packages with pure-Python wheel distributions (no C extensions) are supported.

### Usage

```bash
pip install requests
pip install pandas
pip list
```

```python
with Sandbox() as sb:
    sb.commands.run("pip install requests")
    result = sb.commands.run("python3 -c \"import requests; print(requests.__version__)\"")
    print(result.stdout)
```

### codepod pip registry

The pip registry serves pure-Python wheels that work with RustPython. Packages are resolved from:

```
https://codepod-sandbox.github.io/packages
```

Source: [`codepod-sandbox/packages`](https://github.com/codepod-sandbox/packages) on GitHub — the same repo as the `pkg` registry.

The registry provides a `index.json` listing packages with their wheel files and dependency graphs. Override the registry URL with the `CODEPOD_REGISTRY` environment variable inside the sandbox.

### Limitations

- **Pure Python only.** Packages with C extensions or native binaries cannot be installed. Use the `pkg` manager or built-in native packages (numpy, PIL) for performance-sensitive operations.
- **RustPython compatibility.** Some packages that rely on CPython internals may not work. Standard-library-dependent packages generally work well.
- **Subset of PyPI.** Only packages vetted for pure-Python compatibility are in the registry. If a package isn't available, check if a pure-Python alternative exists.
