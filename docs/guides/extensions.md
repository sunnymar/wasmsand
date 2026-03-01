# Extensions

Extensions let hosts expose custom capabilities to sandbox code — shell commands that participate in pipes and redirects, and Python packages importable from sandbox scripts.

## Overview

An extension consists of:
- A **name** — becomes a shell command in `/bin/<name>`
- A **description** — shown when the user runs `<name> --help`
- A **command handler** — a host-side async function that receives args/stdin and returns stdout/exitCode
- An optional **Python package** — files installed in the VFS at `/usr/lib/python/<name>/`, importable from sandbox Python scripts

## TypeScript

```typescript
const sandbox = await Sandbox.create({
  adapter: new NodeAdapter(),
  wasmDir: './wasm',
  extensions: [
    {
      name: 'llm',
      description: 'Query an LLM. Usage: llm <prompt>',
      command: async ({ args, stdin }) => {
        const prompt = args.join(' ') || stdin;
        const answer = await myLlmApi(prompt);
        return { stdout: answer + '\n', exitCode: 0 };
      },
    },
    {
      name: 'vecdb',
      description: 'Search a vector database. Usage: vecdb <query>',
      command: async ({ args }) => {
        const results = await myVecSearch(args.join(' '));
        return { stdout: JSON.stringify(results) + '\n', exitCode: 0 };
      },
      pythonPackage: {
        version: '1.0.0',
        summary: 'Vector database client',
        files: {
          '__init__.py': 'from codepod_ext import call as _call\n\ndef search(q): return _call("vecdb", "search", query=q)\n',
        },
      },
    },
  ],
});

// Extension commands work like any other command
await sandbox.run('echo "summarize this" | llm');
await sandbox.run('vecdb "similar documents" | jq .results');

// Extension Python packages are importable
await sandbox.run('python3 -c "import vecdb; print(vecdb.search(\'test\'))"');

// Discoverable via standard tools
await sandbox.run('which llm');        // /bin/llm
await sandbox.run('pip list');         // shows vecdb 1.0.0
await sandbox.run('pip show vecdb');   // metadata + file list
```

## Python

```python
from codepod import Sandbox, Extension, PythonPackage

def my_llm_handler(args, stdin, env, cwd):
    prompt = " ".join(args) or stdin
    answer = call_my_llm(prompt)
    return {"stdout": answer + "\n", "exitCode": 0}

with Sandbox(extensions=[
    Extension(
        name="llm",
        description="Query an LLM",
        command=my_llm_handler,
    ),
    Extension(
        name="vecdb",
        description="Vector database search",
        command=lambda args, **_: {"stdout": do_search(args), "exitCode": 0},
        python_package=PythonPackage(
            version="1.0.0",
            summary="Vector database client",
            files={
                "__init__.py": (
                    "from codepod_ext import call as _call\n"
                    "def search(q): return _call('vecdb', 'search', query=q)\n"
                ),
            },
        ),
    ),
]) as sb:
    sb.commands.run("echo hello | llm")
    sb.commands.run("pip list")
```

## Handler interface

Extension command handlers receive:

| Field | Type | Description |
|-------|------|-------------|
| `args` | `string[]` | Command arguments (everything after the command name) |
| `stdin` | `string` | Piped input (empty string if no pipe) |
| `env` | `Record<string, string>` | Current environment variables |
| `cwd` | `string` | Current working directory |

Handlers return:

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | `string` | Standard output |
| `stderr` | `string` (optional) | Standard error |
| `exitCode` | `number` | Exit code (0 = success) |

## Shell integration

Extension commands behave like any other shell command:

- **Pipes** — `echo data | myext | grep result`
- **Redirects** — `myext > output.txt 2> errors.txt`
- **Chaining** — `myext && echo ok || echo fail`
- **Help** — `myext --help` returns the description
- **Discoverability** — `which myext` shows `/bin/myext`

## Python packages

Extensions can include Python packages that are importable from sandbox Python scripts.

Python packages are installed in the VFS at `/usr/lib/python/<name>/` and use the `codepod_ext` bridge module to call back to the host. The bridge is synchronous from the Python side — it uses the WASI fd bridge to call async host handlers.

```python
# In sandbox Python code:
import vecdb
results = vecdb.search("my query")
```

Package metadata is available via pip:

```bash
pip list          # shows installed extension packages
pip show vecdb    # shows version, summary, file list
```

**Note:** Python package extensions require worker execution mode (`security.hardKill: true` in TypeScript) since the synchronous WASI fd bridge needs the main thread free to run async handlers.

**Runtime requirement:** Extensions use [JSPI](https://v8.dev/blog/jspi) (`WebAssembly.Suspending`/`WebAssembly.promising`) to let synchronous WASM code call async host handlers. This requires Deno or Node.js 25+ — Bun does not support JSPI.

## Security model

Extension handlers execute on the host side — they have full host access. This is by design: extensions exist to give sandbox code access to capabilities that require host privileges.

See [Security Architecture](security.md#extension-trust-model) for details on the trust model.
