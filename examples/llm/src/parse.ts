/**
 * Pure parsing utilities for the RLM chat loop.
 * No browser or sandbox dependencies — easily testable with Deno.
 */

/** Write Python code to a temp file and run it.
 *  Base64 avoids heredoc stdin redirection (hangs in WASM shells).
 *  Running as a file (not exec()) preserves correct line numbers in tracebacks.
 */
function pythonCmd(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary);
  return `python3 -c "open('/tmp/_cp.py','w').write(__import__('base64').b64decode('${encoded}').decode())" && python3 /tmp/_cp.py`;
}

/** Extract executable code blocks from a model response.
 *  bash / sh / shell / zsh → run as-is
 *  python / python3 / py (any case) → base64-encoded python3 -c command
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  // Match any word-like language tag, optional trailing whitespace before newline.
  const re = /```(\w+)[^\S\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    const code = m[2].trim();
    if (!code) continue;

    const isPython = lang.startsWith('python') || lang === 'py';
    const isBash = lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh';

    if (isPython) {
      blocks.push(pythonCmd(code));
    } else if (isBash) {
      blocks.push(code);
    }
    // Silently ignore other languages (json, typescript, etc.)
  }
  return blocks;
}

/** If cmd is `llm "query"` or `llm 'query'`, return the query string; else null. */
export function parseLlmCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  const m = trimmed.match(/^llm\s+["']([^"']+)["']\s*$/s);
  return m ? m[1].trim() : null;
}
