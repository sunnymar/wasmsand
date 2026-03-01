# Package Manager

Install WASI binaries into the sandbox at runtime. Packages run inside the WASM sandbox with the same security boundary as built-in coreutils.

## Setup

The package manager is **disabled by default**. Enable it with `packagePolicy.enabled: true`:

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  security: {
    packagePolicy: {
      enabled: true,
      allowedHosts: ['trusted-registry.example.com'],
      maxPackageBytes: 5 * 1024 * 1024,
      maxInstalledPackages: 50,
    },
  },
});
```

## Usage

### TypeScript

```typescript
await sandbox.run('pkg install https://trusted-registry.example.com/mytool.wasm');
await sandbox.run('mytool --help');  // immediately available
await sandbox.run('pkg list');        // show installed packages
await sandbox.run('pkg remove mytool');
```

### Python

```python
with Sandbox() as sb:
    sb.commands.run("pkg install https://trusted-registry.example.com/mytool.wasm")
    sb.commands.run("mytool --help")
    sb.commands.run("pkg list")
    sb.commands.run("pkg remove mytool")
```

**Note:** Package policy configuration is set at the TypeScript orchestrator level. The Python SDK inherits the default policy (disabled).

## Policy options

| Option | Description |
|--------|-------------|
| `enabled` | Whether package installation is enabled (default: `false`) |
| `allowedHosts` | Allowed source hosts. If set, only these hosts are accepted. Supports wildcards (`*.example.com`). |
| `maxPackageBytes` | Maximum size in bytes for a single package |
| `maxInstalledPackages` | Maximum number of installed packages |

## Security

- Packages are fetched from allowed hosts only — host allowlist is enforced before download
- Package names are validated to prevent path traversal
- Installed WASI binaries run inside the same sandbox as built-in coreutils — no additional host access
- Packages are stored in the VFS at `/usr/share/pkg/bin/<name>.wasm`

See [Security Architecture](security.md#package-manager-security) for details.
