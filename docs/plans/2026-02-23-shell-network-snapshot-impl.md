# Shell Builtins, Network Access, and Snapshot/Fork Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add cd/export/unset/date builtins, curl/wget with a generic NetworkGateway policy layer, WASI socket bridge for Python networking, and expose snapshot/fork at the Sandbox/RPC/SDK API levels.

**Architecture:** Shell builtins extend the existing `execSimple()` dispatch in ShellRunner. NetworkGateway is a standalone policy-enforcement class used by builtins and WASI sockets. WASI sockets use SharedArrayBuffer + Atomics to bridge sync WASM calls to async host fetch(). Snapshot/fork wraps existing VFS snapshot/cowClone and adds env state capture.

**Tech Stack:** TypeScript, bun:test, WASI Preview 1, SharedArrayBuffer/Atomics, Python

**Design doc:** `docs/plans/2026-02-23-shell-network-snapshot-design.md`

---

## Task 1: Shell builtin — `cd`

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts:19` (SHELL_BUILTINS), `:286-303` (execSimple dispatch)
- Test: `packages/orchestrator/src/shell/__tests__/shell-runner.test.ts`

**Step 1: Write the failing tests**

Add to `shell-runner.test.ts` at the end, inside the top-level `describe('ShellRunner', ...)`:

```typescript
describe('cd builtin', () => {
  it('changes PWD to an existing directory', async () => {
    vfs.mkdir('/home/user/projects');
    await runner.run('cd /home/user/projects');
    expect(runner.getEnv('PWD')).toBe('/home/user/projects');
  });

  it('cd with no args goes to /home/user', async () => {
    runner.setEnv('PWD', '/tmp');
    await runner.run('cd');
    expect(runner.getEnv('PWD')).toBe('/home/user');
  });

  it('cd - goes to OLDPWD', async () => {
    runner.setEnv('PWD', '/home/user');
    await runner.run('cd /tmp');
    expect(runner.getEnv('PWD')).toBe('/tmp');
    expect(runner.getEnv('OLDPWD')).toBe('/home/user');
    await runner.run('cd -');
    expect(runner.getEnv('PWD')).toBe('/home/user');
    expect(runner.getEnv('OLDPWD')).toBe('/tmp');
  });

  it('cd to non-existent dir returns exit code 1', async () => {
    const result = await runner.run('cd /nonexistent');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such file or directory');
  });

  it('cd to a file returns exit code 1', async () => {
    vfs.writeFile('/tmp/file.txt', new TextEncoder().encode('x'));
    const result = await runner.run('cd /tmp/file.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a directory');
  });

  it('cd .. resolves parent directory', async () => {
    runner.setEnv('PWD', '/home/user');
    await runner.run('cd ..');
    expect(runner.getEnv('PWD')).toBe('/home');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-runner.test.ts`
Expected: FAIL — `cd` is dispatched as a WASM tool, not a builtin

**Step 3: Implement cd builtin**

In `shell-runner.ts`:

1. Add `'cd'` to the `SHELL_BUILTINS` set on line 19:
```typescript
const SHELL_BUILTINS = new Set(['which', 'chmod', 'test', '[', 'pwd', 'cd']);
```

2. Add dispatch case in `execSimple()` after the `pwd` case (around line 303):
```typescript
if (cmdName === 'cd') {
  return this.builtinCd(args);
}
```

3. Add the `builtinCd` method:
```typescript
/** Builtin: cd — change working directory. */
private builtinCd(args: string[]): RunResult {
  let target: string;

  if (args.length === 0) {
    target = '/home/user';
  } else if (args[0] === '-') {
    const oldPwd = this.env.get('OLDPWD');
    if (!oldPwd) {
      return { exitCode: 1, stdout: '', stderr: 'cd: OLDPWD not set\n', executionTimeMs: 0 };
    }
    target = oldPwd;
  } else {
    target = this.resolvePath(args[0]);
  }

  try {
    const stat = this.vfs.stat(target);
    if (stat.type !== 'dir') {
      return { exitCode: 1, stdout: '', stderr: `cd: ${args[0] ?? target}: not a directory\n`, executionTimeMs: 0 };
    }
  } catch {
    return { exitCode: 1, stdout: '', stderr: `cd: ${args[0] ?? target}: no such file or directory\n`, executionTimeMs: 0 };
  }

  const oldPwd = this.env.get('PWD') || '/';
  this.env.set('OLDPWD', oldPwd);
  this.env.set('PWD', target);
  return { ...EMPTY_RESULT };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-runner.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/shell/__tests__/shell-runner.test.ts
git commit -m "feat: add cd builtin to shell runner"
```

---

## Task 2: Shell builtins — `export`, `unset`, `date`

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts:19` (SHELL_BUILTINS), `:286-303` (execSimple dispatch)
- Test: `packages/orchestrator/src/shell/__tests__/shell-runner.test.ts`

**Step 1: Write the failing tests**

Add to `shell-runner.test.ts`:

```typescript
describe('export builtin', () => {
  it('export FOO=bar sets the variable', async () => {
    await runner.run('export FOO=bar');
    expect(runner.getEnv('FOO')).toBe('bar');
  });

  it('export with no args lists all env vars', async () => {
    runner.setEnv('A', '1');
    runner.setEnv('B', '2');
    const result = await runner.run('export');
    expect(result.stdout).toContain('A=1');
    expect(result.stdout).toContain('B=2');
  });

  it('export FOO with no value is a no-op', async () => {
    runner.setEnv('FOO', 'existing');
    await runner.run('export FOO');
    expect(runner.getEnv('FOO')).toBe('existing');
  });
});

describe('unset builtin', () => {
  it('removes a variable from env', async () => {
    runner.setEnv('FOO', 'bar');
    await runner.run('unset FOO');
    expect(runner.getEnv('FOO')).toBeUndefined();
  });

  it('unset non-existent variable is a no-op', async () => {
    const result = await runner.run('unset NONEXISTENT');
    expect(result.exitCode).toBe(0);
  });
});

describe('date builtin', () => {
  it('returns a date string with no args', async () => {
    const result = await runner.run('date');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBeTruthy();
    // Should contain a year
    expect(result.stdout).toMatch(/\d{4}/);
  });

  it('supports +%Y-%m-%d format', async () => {
    const result = await runner.run('date +%Y-%m-%d');
    expect(result.exitCode).toBe(0);
    // Should match YYYY-MM-DD
    expect(result.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('supports +%H:%M:%S format', async () => {
    const result = await runner.run('date +%H:%M:%S');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-runner.test.ts`
Expected: FAIL

**Step 3: Implement the builtins**

In `shell-runner.ts`:

1. Update `SHELL_BUILTINS`:
```typescript
const SHELL_BUILTINS = new Set(['which', 'chmod', 'test', '[', 'pwd', 'cd', 'export', 'unset', 'date']);
```

2. Add dispatch cases in `execSimple()`:
```typescript
if (cmdName === 'export') {
  return this.builtinExport(args);
}
if (cmdName === 'unset') {
  return this.builtinUnset(args);
}
if (cmdName === 'date') {
  return this.builtinDate(args);
}
```

3. Add methods:

```typescript
/** Builtin: export — set env variables (alias for assignment). */
private builtinExport(args: string[]): RunResult {
  if (args.length === 0) {
    // List all env vars
    let stdout = '';
    for (const [key, value] of this.env) {
      stdout += `${key}=${value}\n`;
    }
    return { exitCode: 0, stdout, stderr: '', executionTimeMs: 0 };
  }

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx >= 0) {
      this.env.set(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    }
    // export FOO with no value is a no-op
  }
  return { ...EMPTY_RESULT };
}

/** Builtin: unset — remove env variables. */
private builtinUnset(args: string[]): RunResult {
  for (const name of args) {
    this.env.delete(name);
  }
  return { ...EMPTY_RESULT };
}

/** Builtin: date — print current date/time. */
private builtinDate(args: string[]): RunResult {
  const now = new Date();

  if (args.length > 0 && args[0].startsWith('+')) {
    const format = args[0].slice(1);
    const stdout = formatDate(now, format) + '\n';
    return { exitCode: 0, stdout, stderr: '', executionTimeMs: 0 };
  }

  // Default format: Thu Feb 23 14:30:00 UTC 2026
  const stdout = now.toUTCString() + '\n';
  return { exitCode: 0, stdout, stderr: '', executionTimeMs: 0 };
}
```

4. Add `formatDate` helper function at the bottom of the file (before the closing of the module):

```typescript
/** Simple strftime-like date formatter. Supports common % tokens. */
function formatDate(d: Date, format: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return format.replace(/%([YmdHMSaAbBpZsnT%])/g, (_, code: string) => {
    switch (code) {
      case 'Y': return String(d.getUTCFullYear());
      case 'm': return pad(d.getUTCMonth() + 1);
      case 'd': return pad(d.getUTCDate());
      case 'H': return pad(d.getUTCHours());
      case 'M': return pad(d.getUTCMinutes());
      case 'S': return pad(d.getUTCSeconds());
      case 'a': return days[d.getUTCDay()];
      case 'A': return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
      case 'b': return months[d.getUTCMonth()];
      case 'B': return ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
      case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'Z': return 'UTC';
      case 's': return String(Math.floor(d.getTime() / 1000));
      case 'n': return '\n';
      case 'T': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      case '%': return '%';
      default: return `%${code}`;
    }
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-runner.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/shell/__tests__/shell-runner.test.ts
git commit -m "feat: add export, unset, date builtins to shell runner"
```

---

## Task 3: NetworkGateway — policy enforcement layer

**Files:**
- Create: `packages/orchestrator/src/network/gateway.ts`
- Test: `packages/orchestrator/src/network/__tests__/gateway.test.ts`
- Modify: `packages/orchestrator/src/index.ts` (re-export)

**Step 1: Write the failing tests**

Create `packages/orchestrator/src/network/__tests__/gateway.test.ts`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { NetworkGateway, NetworkAccessDenied } from '../gateway.js';
import type { NetworkPolicy } from '../gateway.js';

describe('NetworkGateway', () => {
  describe('checkAccess', () => {
    it('blocks all requests when no policy lists are set', () => {
      const gw = new NetworkGateway({});
      const result = gw.checkAccess('https://example.com', 'GET');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('no network policy');
    });

    it('allows requests to allowedHosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      expect(gw.checkAccess('https://example.com/api', 'GET').allowed).toBe(true);
    });

    it('blocks requests to hosts not in allowedHosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      expect(gw.checkAccess('https://evil.com', 'GET').allowed).toBe(false);
    });

    it('supports wildcard in allowedHosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['*.example.com'] });
      expect(gw.checkAccess('https://api.example.com/data', 'GET').allowed).toBe(true);
      expect(gw.checkAccess('https://example.com', 'GET').allowed).toBe(false);
    });

    it('blockedHosts blocks specific hosts', () => {
      const gw = new NetworkGateway({ blockedHosts: ['evil.com'] });
      expect(gw.checkAccess('https://evil.com', 'GET').allowed).toBe(false);
      expect(gw.checkAccess('https://good.com', 'GET').allowed).toBe(true);
    });

    it('allowedHosts takes precedence over blockedHosts', () => {
      const gw = new NetworkGateway({
        allowedHosts: ['example.com'],
        blockedHosts: ['example.com'],
      });
      expect(gw.checkAccess('https://example.com', 'GET').allowed).toBe(true);
    });
  });

  describe('fetch', () => {
    it('throws NetworkAccessDenied when access is blocked', async () => {
      const gw = new NetworkGateway({});
      try {
        await gw.fetch('https://example.com');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkAccessDenied);
      }
    });

    it('calls onRequest callback after static checks pass', async () => {
      const onRequest = mock(async () => false);
      const gw = new NetworkGateway({
        allowedHosts: ['example.com'],
        onRequest,
      });
      try {
        await gw.fetch('https://example.com');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkAccessDenied);
      }
      expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.com',
        method: 'GET',
      }));
    });

    it('proceeds when onRequest returns true', async () => {
      const onRequest = mock(async () => true);
      // We can't easily test actual fetch without a server, so we'll
      // test that the gateway reaches the fetch call by mocking globalThis.fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response('ok'));
      try {
        const gw = new NetworkGateway({
          allowedHosts: ['example.com'],
          onRequest,
        });
        const resp = await gw.fetch('https://example.com');
        expect(await resp.text()).toBe('ok');
        expect(globalThis.fetch).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && bun test src/network/__tests__/gateway.test.ts`
Expected: FAIL — file doesn't exist

**Step 3: Implement NetworkGateway**

Create `packages/orchestrator/src/network/gateway.ts`:

```typescript
/**
 * NetworkGateway: policy enforcement layer for all sandbox network access.
 *
 * Checks requests against allowedHosts/blockedHosts lists and an optional
 * async callback before delegating to the host fetch() API. Used by shell
 * builtins (curl, wget) and the WASI socket bridge.
 */

export interface NetworkPolicy {
  /** Whitelist mode: only these hosts allowed. Supports wildcards (*.example.com). */
  allowedHosts?: string[];
  /** Blacklist mode: these hosts blocked. Ignored if allowedHosts is set. */
  blockedHosts?: string[];
  /** Async callback for dynamic allow/deny. Called after static checks pass. */
  onRequest?: (request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }) => Promise<boolean>;
}

export class NetworkAccessDenied extends Error {
  constructor(url: string, reason: string) {
    super(`Network access denied for ${url}: ${reason}`);
    this.name = 'NetworkAccessDenied';
  }
}

export class NetworkGateway {
  private policy: NetworkPolicy;

  constructor(policy: NetworkPolicy) {
    this.policy = policy;
  }

  /** Synchronous check against allow/block lists. */
  checkAccess(url: string, method: string): { allowed: boolean; reason?: string } {
    const host = this.extractHost(url);
    if (host === null) {
      return { allowed: false, reason: 'invalid URL' };
    }

    const { allowedHosts, blockedHosts } = this.policy;

    // If allowedHosts is set, use whitelist mode
    if (allowedHosts !== undefined) {
      if (this.matchesHostList(host, allowedHosts)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `host ${host} not in allowedHosts` };
    }

    // If blockedHosts is set, use blacklist mode
    if (blockedHosts !== undefined) {
      if (this.matchesHostList(host, blockedHosts)) {
        return { allowed: false, reason: `host ${host} is in blockedHosts` };
      }
      return { allowed: true };
    }

    // Neither list set: block all (safe default)
    return { allowed: false, reason: 'no network policy configured (default deny)' };
  }

  /** Fetch with policy enforcement. Throws NetworkAccessDenied on denial. */
  async fetch(url: string, options?: RequestInit): Promise<Response> {
    const method = options?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (options?.headers) {
      const h = options.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) { headers[k] = v; }
      } else {
        Object.assign(headers, h);
      }
    }

    // Static check
    const access = this.checkAccess(url, method);
    if (!access.allowed) {
      throw new NetworkAccessDenied(url, access.reason!);
    }

    // Dynamic callback check
    if (this.policy.onRequest) {
      const allowed = await this.policy.onRequest({ url, method, headers });
      if (!allowed) {
        throw new NetworkAccessDenied(url, 'denied by onRequest callback');
      }
    }

    return globalThis.fetch(url, options);
  }

  private extractHost(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  private matchesHostList(host: string, list: string[]): boolean {
    for (const pattern of list) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        if (host.endsWith(suffix) && host.length > suffix.length && host[host.length - suffix.length - 1] === '.') {
          return true;
        }
      } else if (host === pattern) {
        return true;
      }
    }
    return false;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && bun test src/network/__tests__/gateway.test.ts`
Expected: All tests PASS

**Step 5: Add re-export to index.ts**

In `packages/orchestrator/src/index.ts`, add:
```typescript
export { NetworkGateway, NetworkAccessDenied } from './network/gateway.js';
export type { NetworkPolicy } from './network/gateway.js';
```

**Step 6: Commit**

```bash
git add packages/orchestrator/src/network/gateway.ts packages/orchestrator/src/network/__tests__/gateway.test.ts packages/orchestrator/src/index.ts
git commit -m "feat: add NetworkGateway with policy enforcement"
```

---

## Task 4: curl/wget builtins

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (add curl/wget builtins, accept NetworkGateway)
- Modify: `packages/orchestrator/src/sandbox.ts` (pass network policy to ShellRunner)
- Test: `packages/orchestrator/src/shell/__tests__/shell-runner.test.ts`
- Test: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Step 1: Write the failing tests**

Add to `shell-runner.test.ts`. These tests create a mock-friendly ShellRunner with a NetworkGateway. Since the test setup doesn't pass a gateway, curl should fail. We'll need a helper:

```typescript
import { NetworkGateway } from '../../network/gateway.js';

// Add a new describe block for curl/wget:
describe('curl builtin', () => {
  it('returns error when no NetworkGateway is configured', async () => {
    const result = await runner.run('curl https://example.com');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('network access not configured');
  });
});

describe('curl builtin with gateway', () => {
  let netRunner: ShellRunner;

  beforeEach(() => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL) => {
      return new Response(`response from ${url}`, { status: 200 });
    };
    const gateway = new NetworkGateway({ allowedHosts: ['example.com'] });
    netRunner = new ShellRunner(vfs, mgr, new NodeAdapter(), SHELL_WASM, gateway);
    // Store original to restore
    (netRunner as any)._originalFetch = originalFetch;
  });

  afterEach(() => {
    if ((netRunner as any)._originalFetch) {
      globalThis.fetch = (netRunner as any)._originalFetch;
    }
  });

  it('GET request outputs response body', async () => {
    const result = await netRunner.run('curl https://example.com/data');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('response from');
  });

  it('-o writes output to VFS file', async () => {
    const result = await netRunner.run('curl -o /tmp/out.txt https://example.com/data');
    expect(result.exitCode).toBe(0);
    const content = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
    expect(content).toContain('response from');
  });

  it('blocked host returns error', async () => {
    const result = await netRunner.run('curl https://evil.com/data');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('denied');
  });
});

describe('wget builtin with gateway', () => {
  let netRunner: ShellRunner;

  beforeEach(() => {
    globalThis.fetch = async (url: RequestInfo | URL) => {
      return new Response(`downloaded from ${url}`, { status: 200 });
    };
    const gateway = new NetworkGateway({ allowedHosts: ['example.com'] });
    netRunner = new ShellRunner(vfs, mgr, new NodeAdapter(), SHELL_WASM, gateway);
  });

  it('downloads to VFS file named from URL', async () => {
    const result = await netRunner.run('wget https://example.com/file.txt');
    expect(result.exitCode).toBe(0);
    const content = new TextDecoder().decode(vfs.readFile('/home/user/file.txt'));
    expect(content).toContain('downloaded from');
  });

  it('-O - outputs to stdout', async () => {
    const result = await netRunner.run('wget -O - https://example.com/file.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('downloaded from');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-runner.test.ts`
Expected: FAIL

**Step 3: Implement curl/wget builtins**

1. Modify `ShellRunner` constructor to accept an optional `NetworkGateway`:

In `shell-runner.ts`, add import at top:
```typescript
import { NetworkGateway, NetworkAccessDenied } from '../network/gateway.js';
```

Modify constructor signature:
```typescript
constructor(
  vfs: VFS,
  mgr: ProcessManager,
  adapter: PlatformAdapter,
  shellWasmPath: string,
  gateway?: NetworkGateway,
) {
  // ... existing code
  this.gateway = gateway ?? null;
}
```

Add field:
```typescript
private gateway: NetworkGateway | null = null;
```

Add `'curl'` and `'wget'` to `SHELL_BUILTINS`.

2. Add dispatch in `execSimple()`:
```typescript
if (cmdName === 'curl') {
  return this.builtinCurl(args);
}
if (cmdName === 'wget') {
  return this.builtinWget(args);
}
```

3. Implement builtins:

```typescript
/** Builtin: curl — HTTP client. */
private async builtinCurl(args: string[]): Promise<RunResult> {
  if (!this.gateway) {
    return { exitCode: 1, stdout: '', stderr: 'curl: network access not configured\n', executionTimeMs: 0 };
  }

  let method = 'GET';
  const headers: Record<string, string> = {};
  let data: string | undefined;
  let outputFile: string | undefined;
  let silent = false;
  let headOnly = false;
  let url: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-X' && i + 1 < args.length) {
      method = args[++i];
    } else if (arg === '-H' && i + 1 < args.length) {
      const header = args[++i];
      const colonIdx = header.indexOf(':');
      if (colonIdx > 0) {
        headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
      }
    } else if ((arg === '-d' || arg === '--data') && i + 1 < args.length) {
      data = args[++i];
      if (method === 'GET') method = 'POST';
    } else if (arg === '-o' && i + 1 < args.length) {
      outputFile = this.resolvePath(args[++i]);
    } else if (arg === '-s' || arg === '--silent') {
      silent = true;
    } else if (arg === '-I' || arg === '--head') {
      headOnly = true;
      method = 'HEAD';
    } else if (arg === '-L' || arg === '--location') {
      // Follow redirects is default with fetch()
    } else if (!arg.startsWith('-')) {
      url = arg;
    }
  }

  if (!url) {
    return { exitCode: 1, stdout: '', stderr: 'curl: no URL specified\n', executionTimeMs: 0 };
  }

  try {
    const init: RequestInit = { method, headers };
    if (data) init.body = data;
    if (data && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const response = await this.gateway.fetch(url, init);

    if (headOnly) {
      let headerStr = `HTTP/${response.status}\n`;
      response.headers.forEach((v, k) => { headerStr += `${k}: ${v}\n`; });
      return { exitCode: 0, stdout: headerStr, stderr: '', executionTimeMs: 0 };
    }

    const body = await response.text();

    if (outputFile) {
      this.vfs.writeFile(outputFile, new TextEncoder().encode(body));
      return { exitCode: 0, stdout: '', stderr: '', executionTimeMs: 0 };
    }

    return { exitCode: 0, stdout: body, stderr: '', executionTimeMs: 0 };
  } catch (err) {
    if (err instanceof NetworkAccessDenied) {
      return { exitCode: 1, stdout: '', stderr: `curl: ${err.message}\n`, executionTimeMs: 0 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: '', stderr: `curl: ${msg}\n`, executionTimeMs: 0 };
  }
}

/** Builtin: wget — download files. */
private async builtinWget(args: string[]): Promise<RunResult> {
  if (!this.gateway) {
    return { exitCode: 1, stdout: '', stderr: 'wget: network access not configured\n', executionTimeMs: 0 };
  }

  let outputFile: string | undefined;
  let toStdout = false;
  let quiet = false;
  let url: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-O' && i + 1 < args.length) {
      const val = args[++i];
      if (val === '-') {
        toStdout = true;
      } else {
        outputFile = this.resolvePath(val);
      }
    } else if (arg === '-q') {
      quiet = true;
    } else if (!arg.startsWith('-')) {
      url = arg;
    }
  }

  if (!url) {
    return { exitCode: 1, stdout: '', stderr: 'wget: no URL specified\n', executionTimeMs: 0 };
  }

  try {
    const response = await this.gateway.fetch(url);
    const body = await response.text();

    if (toStdout) {
      return { exitCode: 0, stdout: body, stderr: '', executionTimeMs: 0 };
    }

    // Determine output filename
    const destPath = outputFile ?? this.resolvePath(url.split('/').pop() || 'index.html');
    this.vfs.writeFile(destPath, new TextEncoder().encode(body));

    const stderr = quiet ? '' : `saved to ${destPath}\n`;
    return { exitCode: 0, stdout: '', stderr, executionTimeMs: 0 };
  } catch (err) {
    if (err instanceof NetworkAccessDenied) {
      return { exitCode: 1, stdout: '', stderr: `wget: ${err.message}\n`, executionTimeMs: 0 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: '', stderr: `wget: ${msg}\n`, executionTimeMs: 0 };
  }
}
```

4. Modify `Sandbox` to create and pass the gateway:

In `sandbox.ts`, add import:
```typescript
import { NetworkGateway } from './network/gateway.js';
import type { NetworkPolicy } from './network/gateway.js';
```

Add `network?: NetworkPolicy` to `SandboxOptions`.

In `Sandbox.create()`, after creating the ShellRunner:
```typescript
const gateway = options.network ? new NetworkGateway(options.network) : undefined;
const runner = new ShellRunner(vfs, mgr, adapter, shellWasmPath, gateway);
```

Store `network` and `gateway` as private fields on Sandbox (needed for fork later):
```typescript
private networkPolicy: NetworkPolicy | undefined;
private gateway: NetworkGateway | undefined;
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-runner.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/shell/__tests__/shell-runner.test.ts packages/orchestrator/src/sandbox.ts
git commit -m "feat: add curl/wget builtins with NetworkGateway integration"
```

---

## Task 5: Snapshot/fork at Sandbox API level

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (add snapshot/restore/fork methods, expose internal getters)
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (add getEnvMap/setEnvMap for snapshot)
- Test: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Step 1: Write the failing tests**

Add to `sandbox.test.ts`:

```typescript
describe('snapshot and restore', () => {
  it('snapshot captures VFS + env state', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('v1'));
    sandbox.setEnv('MY_VAR', 'original');
    const snapId = sandbox.snapshot();

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('v2'));
    sandbox.setEnv('MY_VAR', 'changed');
    sandbox.writeFile('/tmp/new.txt', new TextEncoder().encode('new'));

    sandbox.restore(snapId);
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/data.txt'))).toBe('v1');
    expect(sandbox.getEnv('MY_VAR')).toBe('original');
    expect(() => sandbox.stat('/tmp/new.txt')).toThrow();
  });

  it('snapshots are reusable', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('snap'));
    const snapId = sandbox.snapshot();

    sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('changed1'));
    sandbox.restore(snapId);
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/f.txt'))).toBe('snap');

    sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('changed2'));
    sandbox.restore(snapId);
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/f.txt'))).toBe('snap');
  });

  it('restore throws for invalid snapshot ID', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    expect(() => sandbox.restore('nonexistent')).toThrow();
  });
});

describe('fork', () => {
  it('creates an independent sandbox with COW VFS', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/shared.txt', new TextEncoder().encode('original'));
    sandbox.setEnv('FORKED', 'yes');

    const child = await sandbox.fork();
    try {
      // Child sees the parent's file
      expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('original');
      // Child sees inherited env
      expect(child.getEnv('FORKED')).toBe('yes');

      // Writes in child don't affect parent
      child.writeFile('/tmp/shared.txt', new TextEncoder().encode('child'));
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/shared.txt'))).toBe('original');
      expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('child');

      // New files in child don't appear in parent
      child.writeFile('/tmp/child-only.txt', new TextEncoder().encode('x'));
      expect(() => sandbox.stat('/tmp/child-only.txt')).toThrow();
    } finally {
      child.destroy();
    }
  });

  it('forked sandbox can run commands independently', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      const result = await child.run('echo hello from fork');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello from fork');
    } finally {
      child.destroy();
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && bun test src/__tests__/sandbox.test.ts`
Expected: FAIL — `sandbox.snapshot()` etc. don't exist

**Step 3: Implement snapshot/restore/fork**

1. Add `getEnvMap`/`setEnvMap` to `ShellRunner`:

```typescript
/** Return a copy of all env vars (for snapshot). */
getEnvMap(): Map<string, string> {
  return new Map(this.env);
}

/** Replace all env vars (for restore). */
setEnvMap(env: Map<string, string>): void {
  this.env = new Map(env);
}
```

2. Add methods and fields to `Sandbox`:

```typescript
// New private fields:
private envSnapshots: Map<string, Map<string, string>> = new Map();
private adapter: PlatformAdapter;
private wasmDir: string;
private shellWasmPath: string;
private mgr: ProcessManager;

// Store these in constructor:
private constructor(
  vfs: VFS,
  runner: ShellRunner,
  timeoutMs: number,
  adapter: PlatformAdapter,
  wasmDir: string,
  shellWasmPath: string,
  mgr: ProcessManager,
  networkPolicy?: NetworkPolicy,
  gateway?: NetworkGateway,
) {
  this.vfs = vfs;
  this.runner = runner;
  this.timeoutMs = timeoutMs;
  this.adapter = adapter;
  this.wasmDir = wasmDir;
  this.shellWasmPath = shellWasmPath;
  this.mgr = mgr;
  this.networkPolicy = networkPolicy;
  this.gateway = gateway;
}

// Update create() to pass these through.

snapshot(): string {
  this.assertAlive();
  const id = this.vfs.snapshot();
  this.envSnapshots.set(id, this.runner.getEnvMap());
  return id;
}

restore(id: string): void {
  this.assertAlive();
  this.vfs.restore(id);
  const envSnap = this.envSnapshots.get(id);
  if (envSnap) {
    this.runner.setEnvMap(envSnap);
  }
}

async fork(): Promise<Sandbox> {
  this.assertAlive();
  const childVfs = this.vfs.cowClone();
  const childMgr = new ProcessManager(childVfs, this.adapter);

  // Re-register tools from the same wasmDir
  const tools = await this.adapter.scanTools(this.wasmDir);
  for (const [name, path] of tools) {
    childMgr.registerTool(name, path);
  }
  if (!tools.has('python3')) {
    childMgr.registerTool('python3', `${this.wasmDir}/python3.wasm`);
  }

  const childGateway = this.networkPolicy ? new NetworkGateway(this.networkPolicy) : undefined;
  const childRunner = new ShellRunner(childVfs, childMgr, this.adapter, this.shellWasmPath, childGateway);

  // Copy env
  const envMap = this.runner.getEnvMap();
  for (const [k, v] of envMap) {
    childRunner.setEnv(k, v);
  }

  return new Sandbox(
    childVfs, childRunner, this.timeoutMs,
    this.adapter, this.wasmDir, this.shellWasmPath,
    childMgr, this.networkPolicy, childGateway,
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && bun test src/__tests__/sandbox.test.ts`
Expected: All tests PASS

**Step 5: Update index.ts exports**

No new exports needed — `snapshot`, `restore`, `fork` are methods on the already-exported `Sandbox` class.

**Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "feat: expose snapshot/restore/fork at Sandbox API level"
```

---

## Task 6: Snapshot/fork at RPC + Python SDK level

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts` (add snapshot.create, snapshot.restore, sandbox.fork, SandboxLike interface)
- Test: `packages/sdk-server/src/dispatcher.test.ts`
- Modify: `packages/sdk-server/src/server.ts` (sandbox registry for fork)
- Modify: `packages/python-sdk/src/wasmsand/sandbox.py` (add snapshot/restore/fork methods)
- Modify: `packages/python-sdk/src/wasmsand/commands.py` (if needed)

**Step 1: Write the failing tests for Dispatcher**

Add to `dispatcher.test.ts`. First, update `SandboxLike` mock:

```typescript
// Update createMockSandbox to add new methods:
function createMockSandbox(): SandboxLike {
  return {
    // ... existing mocks ...
    snapshot: mock(() => '1'),
    restore: mock((_id: string) => {}),
    fork: mock(async () => createMockSandbox()),
  };
}
```

Add test blocks:

```typescript
describe('snapshot.create', () => {
  it('calls sandbox.snapshot() and returns id', async () => {
    const result = await dispatcher.dispatch('snapshot.create', {});
    expect(sandbox.snapshot).toHaveBeenCalled();
    expect(result).toEqual({ id: '1' });
  });
});

describe('snapshot.restore', () => {
  it('calls sandbox.restore() with id', async () => {
    const result = await dispatcher.dispatch('snapshot.restore', { id: '1' });
    expect(sandbox.restore).toHaveBeenCalledWith('1');
    expect(result).toEqual({ ok: true });
  });

  it('rejects when id param is missing', async () => {
    await expect(dispatcher.dispatch('snapshot.restore', {})).rejects.toMatchObject({
      code: -32602,
    });
  });
});

describe('sandbox.fork', () => {
  it('calls sandbox.fork() and returns sandboxId', async () => {
    const result = await dispatcher.dispatch('sandbox.fork', {});
    expect(sandbox.fork).toHaveBeenCalled();
    expect(result).toHaveProperty('sandboxId');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/sdk-server && bun test src/dispatcher.test.ts`
Expected: FAIL

**Step 3: Implement**

1. Update `SandboxLike` interface in `dispatcher.ts`:

```typescript
export interface SandboxLike {
  // ... existing methods ...
  snapshot(): string;
  restore(id: string): void;
  fork(): Promise<SandboxLike>;
}
```

2. Add dispatch cases and a fork registry:

```typescript
export class Dispatcher {
  private sandbox: SandboxLike;
  private killed = false;
  private forks: Map<string, SandboxLike> = new Map();
  private nextForkId = 1;

  // ... existing code ...

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      switch (method) {
        // ... existing cases ...
        case 'snapshot.create':
          return this.snapshotCreate();
        case 'snapshot.restore':
          return this.snapshotRestore(params);
        case 'sandbox.fork':
          return await this.sandboxFork();
        default:
          throw this.rpcError(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      // ... existing error handling ...
    }
  }

  private snapshotCreate() {
    const id = this.sandbox.snapshot();
    return { id };
  }

  private snapshotRestore(params: Record<string, unknown>) {
    const id = this.requireString(params, 'id');
    this.sandbox.restore(id);
    return { ok: true };
  }

  private async sandboxFork() {
    const child = await this.sandbox.fork();
    const sandboxId = String(this.nextForkId++);
    this.forks.set(sandboxId, child);
    return { sandboxId };
  }
}
```

3. Update Python SDK — add methods to `Sandbox` class in `sandbox.py`:

```python
def snapshot(self) -> str:
    """Save current VFS + env state. Returns snapshot ID."""
    result = self._client.call("snapshot.create", {})
    return result["id"]

def restore(self, snapshot_id: str) -> None:
    """Restore to a previous snapshot."""
    self._client.call("snapshot.restore", {"id": snapshot_id})

def fork(self) -> "Sandbox":
    """Create an independent forked sandbox."""
    result = self._client.call("sandbox.fork", {})
    forked = object.__new__(Sandbox)
    forked._client = self._client
    forked.commands = Commands(self._client)
    forked.files = Files(self._client)
    return forked
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/sdk-server && bun test src/dispatcher.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/sdk-server/src/dispatcher.ts packages/sdk-server/src/dispatcher.test.ts packages/sdk-server/src/server.ts packages/python-sdk/src/wasmsand/sandbox.py
git commit -m "feat: expose snapshot/restore/fork at RPC and Python SDK levels"
```

---

## Task 7: WASI socket bridge via SharedArrayBuffer

**Files:**
- Create: `packages/orchestrator/src/network/bridge.ts` (NetworkBridge — SAB sync/async bridge)
- Create: `packages/orchestrator/src/network/fetch-worker.ts` (Worker that performs async fetch)
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts` (implement sock_* stubs)
- Modify: `packages/orchestrator/src/sandbox.ts` (create bridge, pass to WasiHost)
- Modify: `packages/orchestrator/src/process/manager.ts` (pass bridge to WasiHost)
- Test: `packages/orchestrator/src/network/__tests__/bridge.test.ts`

This is the most complex task. The core mechanism:

1. **NetworkBridge** manages a SharedArrayBuffer with a protocol:
   - Int32[0] = status flag (0=idle, 1=request_ready, 2=response_ready, 3=error)
   - Int32[1] = request/response data length
   - Remaining bytes = serialized JSON request or response body

2. **Fetch worker** (runs in a Worker thread) listens for requests via Atomics.wait, performs fetch via NetworkGateway, writes response back.

3. **WasiHost sock_send/sock_recv** write/read from the SAB synchronously using Atomics.wait/notify.

**Step 1: Write the failing tests**

Create `packages/orchestrator/src/network/__tests__/bridge.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { NetworkBridge } from '../bridge.js';
import { NetworkGateway } from '../gateway.js';

describe('NetworkBridge', () => {
  let bridge: NetworkBridge;

  afterEach(() => {
    bridge?.dispose();
  });

  it('performs a synchronous fetch via the bridge', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('bridge response', { status: 200 });

    try {
      const gateway = new NetworkGateway({ allowedHosts: ['example.com'] });
      bridge = new NetworkBridge(gateway);
      await bridge.start();

      const result = bridge.fetchSync('https://example.com/data', 'GET', {});
      expect(result.status).toBe(200);
      expect(result.body).toBe('bridge response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns error for blocked hosts', async () => {
    const gateway = new NetworkGateway({ blockedHosts: ['evil.com'] });
    bridge = new NetworkBridge(gateway);
    await bridge.start();

    const result = bridge.fetchSync('https://evil.com', 'GET', {});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.error).toBeTruthy();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && bun test src/network/__tests__/bridge.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement NetworkBridge**

Create `packages/orchestrator/src/network/bridge.ts`:

```typescript
/**
 * NetworkBridge: sync ↔ async bridge for WASI socket calls.
 *
 * Uses SharedArrayBuffer + Atomics to allow synchronous WASM code to
 * make network requests that are fulfilled asynchronously by a Worker.
 *
 * Protocol (over SharedArrayBuffer):
 *   Int32[0] = status: 0=idle, 1=request_ready, 2=response_ready, 3=error
 *   Int32[1] = data length (bytes)
 *   Bytes 8+ = JSON request or response payload
 */

import { Worker } from 'node:worker_threads';
import type { NetworkGateway } from './gateway.js';

const SAB_SIZE = 16 * 1024 * 1024; // 16MB buffer
const STATUS_IDLE = 0;
const STATUS_REQUEST_READY = 1;
const STATUS_RESPONSE_READY = 2;
const STATUS_ERROR = 3;

export interface SyncFetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  error?: string;
}

export class NetworkBridge {
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private uint8: Uint8Array;
  private worker: Worker | null = null;
  private gateway: NetworkGateway;

  constructor(gateway: NetworkGateway) {
    this.gateway = gateway;
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
    this.uint8 = new Uint8Array(this.sab);
  }

  async start(): Promise<void> {
    // Create worker inline using a data URL to avoid a separate file
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const sab = workerData.sab;
      const int32 = new Int32Array(sab);
      const uint8 = new Uint8Array(sab);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      async function loop() {
        while (true) {
          // Wait for a request
          Atomics.wait(int32, 0, 0); // wait while idle
          if (Atomics.load(int32, 0) !== 1) continue;

          // Read request
          const len = Atomics.load(int32, 1);
          const reqJson = decoder.decode(uint8.slice(8, 8 + len));
          const req = JSON.parse(reqJson);

          try {
            const resp = await fetch(req.url, {
              method: req.method,
              headers: req.headers,
              body: req.body || undefined,
            });
            const body = await resp.text();
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            const result = JSON.stringify({ status: resp.status, body, headers });
            const encoded = encoder.encode(result);
            uint8.set(encoded, 8);
            Atomics.store(int32, 1, encoded.byteLength);
            Atomics.store(int32, 0, 2); // response ready
          } catch (err) {
            const result = JSON.stringify({ status: 0, body: '', headers: {}, error: err.message });
            const encoded = encoder.encode(result);
            uint8.set(encoded, 8);
            Atomics.store(int32, 1, encoded.byteLength);
            Atomics.store(int32, 0, 3); // error
          }
          Atomics.notify(int32, 0);
        }
      }
      loop();
    `;

    this.worker = new Worker(workerCode, {
      eval: true,
      workerData: { sab: this.sab },
    });
  }

  /**
   * Synchronous fetch — blocks the calling thread until the worker completes.
   * Safe to call from WASI host functions.
   */
  fetchSync(url: string, method: string, headers: Record<string, string>, body?: string): SyncFetchResult {
    // First check gateway policy synchronously
    const access = this.gateway.checkAccess(url, method);
    if (!access.allowed) {
      return { status: 403, body: '', headers: {}, error: access.reason };
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Write request to SAB
    const reqJson = JSON.stringify({ url, method, headers, body });
    const reqEncoded = encoder.encode(reqJson);
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    // Block until response
    Atomics.wait(this.int32, 0, STATUS_REQUEST_READY);

    // Read response
    const status = Atomics.load(this.int32, 0);
    const len = Atomics.load(this.int32, 1);
    const respJson = decoder.decode(this.uint8.slice(8, 8 + len));

    // Reset to idle
    Atomics.store(this.int32, 0, STATUS_IDLE);

    const result = JSON.parse(respJson) as SyncFetchResult;
    if (status === STATUS_ERROR) {
      result.error = result.error || 'unknown error';
    }
    return result;
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
```

**Step 4: Implement WASI socket stubs in wasi-host.ts**

The sock_* implementation is a simplified HTTP-over-sockets approach. Since RustPython's socket module attempts standard TCP/HTTP, we intercept at the WASI level and route to the bridge.

In `wasi-host.ts`, modify the constructor to accept an optional `NetworkBridge`:

```typescript
import type { NetworkBridge } from '../network/bridge.js';

export interface WasiHostOptions {
  // ... existing fields
  networkBridge?: NetworkBridge;
}
```

Store it:
```typescript
private networkBridge: NetworkBridge | null;
// In constructor:
this.networkBridge = options.networkBridge ?? null;
```

Replace the `sock_send` and `sock_recv` stubs with implementations that use the bridge. This is simplified — full socket emulation is complex, so we implement a minimal HTTP request/response flow:

```typescript
// Connection state for socket emulation
private sockConnections: Map<number, {
  host: string;
  port: number;
  requestBuf: Uint8Array[];
  responseBuf: Uint8Array | null;
  responseOffset: number;
}> = new Map();

private sockSend(fd: number, iovsPtr: number, iovsLen: number, _flags: number, nwrittenPtr: number): number {
  if (!this.networkBridge) return WASI_ENOSYS;

  const view = this.getView();
  const bytes = this.getBytes();
  const iovecs = readIovecs(view, iovsPtr, iovsLen);

  const conn = this.sockConnections.get(fd);
  if (!conn) return WASI_EBADF;

  let totalWritten = 0;
  for (const iov of iovecs) {
    const data = bytes.slice(iov.buf, iov.buf + iov.len);
    conn.requestBuf.push(data);
    totalWritten += data.byteLength;
  }

  // Try to parse the accumulated request buffer as HTTP
  const fullRequest = concatBuffers(conn.requestBuf);
  const requestStr = this.decoder.decode(fullRequest);

  // Check if we have a complete HTTP request (ends with \r\n\r\n)
  if (requestStr.includes('\r\n\r\n')) {
    const result = this.processHttpRequest(requestStr, conn.host, conn.port);
    conn.responseBuf = this.encoder.encode(result);
    conn.responseOffset = 0;
    conn.requestBuf = [];
  }

  const viewAfter = this.getView();
  viewAfter.setUint32(nwrittenPtr, totalWritten, true);
  return WASI_ESUCCESS;
}

private sockRecv(fd: number, iovsPtr: number, iovsLen: number, _flags: number, nreadPtr: number): number {
  if (!this.networkBridge) return WASI_ENOSYS;

  const conn = this.sockConnections.get(fd);
  if (!conn || !conn.responseBuf) return WASI_EBADF;

  const view = this.getView();
  const bytes = this.getBytes();
  const iovecs = readIovecs(view, iovsPtr, iovsLen);

  let totalRead = 0;
  for (const iov of iovecs) {
    const remaining = conn.responseBuf.byteLength - conn.responseOffset;
    if (remaining <= 0) break;
    const toRead = Math.min(iov.len, remaining);
    bytes.set(conn.responseBuf.subarray(conn.responseOffset, conn.responseOffset + toRead), iov.buf);
    conn.responseOffset += toRead;
    totalRead += toRead;
  }

  const viewAfter = this.getView();
  viewAfter.setUint32(nreadPtr, totalRead, true);
  return WASI_ESUCCESS;
}

private processHttpRequest(requestStr: string, host: string, port: number): string {
  // Parse first line: GET /path HTTP/1.1
  const firstLine = requestStr.split('\r\n')[0];
  const parts = firstLine.split(' ');
  const method = parts[0] || 'GET';
  const path = parts[1] || '/';
  const scheme = port === 443 ? 'https' : 'http';
  const url = `${scheme}://${host}${path}`;

  // Parse headers
  const headerLines = requestStr.split('\r\n\r\n')[0].split('\r\n').slice(1);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }

  // Extract body (after \r\n\r\n)
  const bodyStart = requestStr.indexOf('\r\n\r\n');
  const body = bodyStart >= 0 ? requestStr.slice(bodyStart + 4) : undefined;

  // Synchronous fetch via bridge
  const result = this.networkBridge!.fetchSync(url, method, headers, body || undefined);

  // Format as HTTP response
  let response = `HTTP/1.1 ${result.status} OK\r\n`;
  for (const [k, v] of Object.entries(result.headers)) {
    response += `${k}: ${v}\r\n`;
  }
  response += `Content-Length: ${Buffer.byteLength(result.body)}\r\n`;
  response += '\r\n';
  response += result.body;
  return response;
}
```

Update `getImports()` to use the real implementations instead of stubs:
```typescript
sock_send: this.sockSend.bind(this),
sock_recv: this.sockRecv.bind(this),
sock_shutdown: this.sockShutdown.bind(this),
```

Where `sockShutdown` cleans up the connection:
```typescript
private sockShutdown(fd: number, _how: number): number {
  this.sockConnections.delete(fd);
  return WASI_ESUCCESS;
}
```

**Step 5: Wire bridge through ProcessManager and Sandbox**

In `ProcessManager`, accept and pass through the bridge:
```typescript
// manager.ts - add field and constructor param
private networkBridge: NetworkBridge | null;

constructor(vfs: VFS, adapter: PlatformAdapter, networkBridge?: NetworkBridge) {
  this.networkBridge = networkBridge ?? null;
  // ...
}

// In spawn(), pass to WasiHost:
const host = new WasiHost({
  vfs: this.vfs,
  args: [toolName, ...options.args],
  env: options.env ?? {},
  preopens: { '/': '/' },
  stdin: options.stdinData,
  networkBridge: this.networkBridge ?? undefined,
});
```

In `Sandbox.create()`, create bridge if network policy exists:
```typescript
let bridge: NetworkBridge | undefined;
if (options.network && gateway) {
  bridge = new NetworkBridge(gateway);
  await bridge.start();
}
const mgr = new ProcessManager(vfs, adapter, bridge);
```

Store `bridge` as a field and dispose in `destroy()`:
```typescript
destroy(): void {
  this.destroyed = true;
  this.bridge?.dispose();
}
```

**Step 6: Run tests to verify they pass**

Run: `cd packages/orchestrator && bun test src/network/__tests__/bridge.test.ts`
Run: `cd packages/orchestrator && bun test` (full suite)
Expected: All tests PASS

**Step 7: Commit**

```bash
git add packages/orchestrator/src/network/bridge.ts packages/orchestrator/src/wasi/wasi-host.ts packages/orchestrator/src/process/manager.ts packages/orchestrator/src/sandbox.ts packages/orchestrator/src/network/__tests__/bridge.test.ts
git commit -m "feat: add WASI socket bridge via SharedArrayBuffer for Python networking"
```

---

## Task 8: Run full test suite and verify everything works together

**Step 1: Run all orchestrator tests**

Run: `cd packages/orchestrator && bun test`
Expected: All tests PASS

**Step 2: Run SDK server tests**

Run: `cd packages/sdk-server && bun test`
Expected: All tests PASS

**Step 3: Verify exports compile**

Run: `cd packages/orchestrator && bun run build`
Expected: Build succeeds with no type errors

**Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: test suite fixups after feature integration"
```
