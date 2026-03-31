import { Sandbox, BrowserAdapter } from '@codepod/sandbox';
import type { SubAgentFn } from './types.js';

const WASM_BASE = `${import.meta.env.BASE_URL}wasm`.replace(/\/\//g, '/');

const MAX_SUB_DEPTH = 2;

// Exported for testing — maps Vite glob keys to /src/ VFS paths
export function buildVfsPaths(glob: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, content] of Object.entries(glob)) {
    // key is like './main.tsx' or './components/Chat.tsx'
    const rel = key.startsWith('./') ? key.slice(2) : key;
    out[`/src/${rel}`] = content;
  }
  return out;
}

export async function initSandbox(
  subAgentRef: { current: SubAgentFn | null },
): Promise<Sandbox> {
  const adapter = new BrowserAdapter();

  // Import all source files at build time.
  // Vite 6: `as: 'raw'` was removed; use query + import instead.
  const sources = import.meta.glob('./**/*.{ts,tsx,css,html}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  const enc = new TextEncoder();
  const mountFiles: Record<string, Uint8Array> = {};
  for (const [key, content] of Object.entries(sources)) {
    const rel = key.startsWith('./') ? key.slice(2) : key;
    mountFiles[rel] = enc.encode(content);
  }

  // Depth counter to prevent infinite recursion across nested llm calls.
  let llmDepth = 0;

  // Mount at /src/ via Sandbox.create() — HostMount builds the directory structure
  // automatically, bypassing VFS mode-bit restrictions on top-level directories.
  const sandbox = await Sandbox.create({
    adapter,
    wasmDir: WASM_BASE,
    mounts: [
      { path: '/src', files: mountFiles },
      // Pre-create /context/ so Chat.tsx can write files there before each turn.
      { path: '/context', files: {}, writable: true },
    ],
    packages: ['numpy'],
    extensions: [
      {
        name: 'llm',
        description: 'Invoke a sub-LLM agent. Usage: llm "task description"',
        usage: 'llm <task>',
        command: async (input) => {
          if (llmDepth >= MAX_SUB_DEPTH) {
            return { stdout: '', stderr: `Max recursion depth (${MAX_SUB_DEPTH}) reached.`, exitCode: 1 };
          }
          const fn = subAgentRef.current;
          if (!fn) {
            return { stdout: '', stderr: 'Sub-agent not ready — please wait and retry.', exitCode: 1 };
          }
          const task = input.args.join(' ').trim();
          const context = input.stdin.trim() || undefined;
          llmDepth++;
          try {
            const answer = await fn(task, context);
            return { stdout: answer, stderr: '', exitCode: 0 };
          } catch (err) {
            return { stdout: '', stderr: String(err), exitCode: 1 };
          } finally {
            llmDepth--;
          }
        },
        pythonPackage: {
          version: '1.0.0',
          summary: 'Sub-LLM agent invocation for the RLM pattern.',
          files: {
            '__init__.py': `from llm._shim import run as _run


def sub_llm(task, context=None):
    """Invoke a sub-LLM agent and return its text answer.

    Args:
        task: Description of what the sub-agent should do.
        context: Optional context string passed as stdin.
    Returns:
        The sub-agent's final answer as a string.
    """
    r = _run(task, stdin=context or '')
    if r.get('exit_code', 0) != 0 and r.get('stderr', ''):
        raise RuntimeError(f'llm sub-agent error: {r["stderr"].strip()}')
    return r.get('stdout', '').strip()


def FINAL(answer):
    """Signal the final answer and terminate the current agent.

    Prints a sentinel that the chat loop detects, then stops running code blocks.
    Call this as the last statement when you have your final answer.
    """
    print(f'__FINAL__:{answer}', end='', flush=True)
`,
          },
        },
      },
    ],
  });

  return sandbox;
}

export async function runBash(
  sandbox: Sandbox,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.run(command);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
  };
}
