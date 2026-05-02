# Design: Browser LLM Chat Demo (`examples/llm`)

**Date:** 2026-03-23
**Status:** Approved

## Overview

A browser-based chat application that runs a 2–4B parameter LLM via WebGPU and
gives it a single tool — the codepod sandbox — to answer questions, explore
files, and execute code. The sandbox VFS is pre-loaded with the demo's own
source files, making the app self-referential.

**Research question:** are small 2–4B models capable enough to use a bash
sandbox reliably as a tool?

## Repository location

```
codepod/
├── examples/
│   ├── web-cli/     ← packages/web moved here (no code changes)
│   └── llm/         ← this project
```

`packages/web` is relocated to `examples/web-cli`. No code changes; only the
path moves. GH Pages deploys `examples/llm` (replaces the current live demo).
`examples/web-cli` is a standalone example in the repo but not deployed.

## Runtime constraints

- **Requires Chromium** (Chrome 113+). WebGPU and JSPI are both Chromium-only
  today; this is pre-existing for codepod (JSPI needed for Python) and is
  documented, not a new limitation.
- No server. Everything runs in the browser tab: WASM sandbox + WebGPU
  inference.

## Tech stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Bundler | Vite | Consistent with `examples/web-cli` |
| UI framework | React 18 + TypeScript | Chat UI has enough reactive state to justify it |
| LLM runtime | WebLLM (`@mlc-ai/web-llm`) | Best WebGPU support, wide model zoo, OpenAI-compatible API |
| Model | `Qwen2.5-3B-Instruct-q4f16_1-MLC` | ~1.8GB, strong tool-calling, cached in IndexedDB |
| Sandbox | `@codepod/sandbox` + `BrowserAdapter` | Existing browser support, no server needed |

## File structure

```
examples/llm/
├── index.html
├── vite.config.ts
├── package.json
├── tsconfig.json
├── public/
│   └── wasm/              # wasm artifacts (copy-wasm script, same as web-cli)
└── src/
    ├── main.tsx            # React entry, mounts <App />
    ├── App.tsx             # Boot state machine (booting | ready | error)
    ├── components/
    │   ├── ModelLoader.tsx # Download progress bar + status text
    │   ├── Chat.tsx        # Message list + input box
    │   └── ToolCall.tsx    # Collapsible bash command + output block
    ├── sandbox.ts          # codepod Sandbox init, VFS population
    ├── llm.ts              # WebLLM engine init, streaming wrapper
    └── chat.ts             # Tool-call loop
```

## Boot sequence

Both steps start in parallel when `App` mounts:

1. **Sandbox init** (`sandbox.ts`): `Sandbox.create({ adapter: new BrowserAdapter(), wasmDir })`,
   then write source files to `/src/` in the VFS.
2. **Model load** (`llm.ts`): `CreateMLCEngine(MODEL_ID, { initProgressCallback })`.
   First visit: ~1.8GB download, progress shown. Subsequent visits: instant from
   IndexedDB cache.

When both resolve, the app transitions `booting → ready`.

## VFS population

Source files are inlined at build time using Vite's glob import:

```typescript
const sources = import.meta.glob('../../src/**/*.{ts,tsx,css,html}', { as: 'raw', eager: true });
```

Each entry is written to `/src/<relative-path>` in the sandbox VFS. This gives
the LLM a realistic, self-contained codebase to explore.

## Tool interface

A single tool is registered with the LLM:

```typescript
const BASH_TOOL = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command in the sandbox. Working directory is /src/.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
      },
      required: ['command'],
    },
  },
} as const;
```

The sandbox `run()` result (`{ stdout, stderr, exitCode }`) is returned as the
tool result. Both stdout and stderr are included so the model can see errors.

## System prompt

```
You have access to a sandbox via the bash tool. The sandbox provides a full
POSIX shell with 95+ Unix commands and a Python 3 runtime (including numpy).

The sandbox filesystem has the demo's source files at /src/. You can run shell
commands, pipe them together, use awk/sed/jq, run python3 -c for quick
computations, or write a script to /tmp/ and execute it.

Keep your commands focused. Prefer python3 for computation and data
manipulation where shell syntax would be awkward.
```

## Tool-call loop (`chat.ts`)

```
user sends message
  → append { role: 'user', content } to messages[]
  → call streamCompletion(messages, tools=[BASH_TOOL])
  → accumulate streaming chunks into currentTurn: Part[]
    (Part = TextPart | ToolCallPart | ToolResultPart, rendered in order)

  if finish_reason === 'tool_calls':
    → extract tool call (name='bash', args.command)
    → append ToolCallPart to currentTurn (command visible immediately)
    → await sandbox.run(command)
    → append ToolResultPart (stdout+stderr, collapsible)
    → append assistant + tool messages to messages[]
    → loop (max MAX_TOOL_CALLS = 15 iterations)
      → if limit hit: append system note "Tool call limit reached" and stop

  if finish_reason === 'stop':
    → finalise assistant message
    → done
```

The cap of 15 is a named constant in `chat.ts`. Small models can loop; this
prevents runaway execution.

## UI rendering

Each assistant turn renders its `Part[]` in order:

- **TextPart** → text bubble (streamed, tokens append live)
- **ToolCallPart** → `<ToolCall>` component showing the command
- **ToolResultPart** → `<ToolCall>` component updated with stdout/stderr,
  collapsed by default, click to expand

This makes the model's reasoning and actions fully transparent to the user.

## Component responsibilities

| Component | Responsibility |
|-----------|---------------|
| `App` | Boot state machine; renders `ModelLoader` or `Chat` |
| `ModelLoader` | Download progress bar; brief flash on cache hit |
| `Chat` | Owns `messages[]` state; handles input submit; calls `runChat()` |
| `ToolCall` | Displays command + result; collapsible; non-zero exit codes shown in red |

## Error handling

| Scenario | Behaviour |
|----------|-----------|
| WebGPU unavailable | `App` transitions to `error` state; message explains Chrome requirement |
| Model download fails | `App` transitions to `error` state with retry button |
| `sandbox.run()` non-zero exit | Full stdout+stderr included in tool result; model sees and adapts |
| Tool call loop cap hit (15) | Inline note appended: "Reached tool call limit — stopping." |
| Unhandled exception | React error boundary; friendly message |

## Manual smoke test checklist

- [ ] Page loads in Chrome with no console errors
- [ ] Model download progress bar appears on first visit
- [ ] Second visit: model loads from cache (< 2s)
- [ ] "List the files in /src" → bash tool call fires, returns file list
- [ ] Multi-turn: follow-up question uses prior context
- [ ] Non-zero exit code (e.g. `cat /nonexistent`) → stderr shown in red in tool result
- [ ] Input disabled while model is generating

## Out of scope

- Model selector (single model for now; architecture supports adding it later)
- Safari / Firefox support (blocked by JSPI, pre-existing constraint)
- Automated tests (WebGPU + model weights not practical in CI)
- Server-side component (fully static, hosted on GH Pages)
