/**
 * Pure parsing utilities for the RLM chat loop.
 * No browser or sandbox dependencies — easily testable with Deno.
 */

/** A code block extracted from a model response, tagged by language. */
export type CodeBlock =
  | { lang: 'bash'; code: string }
  | { lang: 'python'; code: string };

/** Extract executable code blocks from a model response.
 *  bash / sh / shell / zsh → { lang: 'bash', code }
 *  python / python3 / py (any case) → { lang: 'python', code }
 *  Other languages (json, typescript, etc.) are silently ignored.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // Match any word-like language tag, optional trailing whitespace before newline.
  const re = /```(\w+)[^\S\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    const code = m[2].trim();
    if (!code) continue;

    if (lang.startsWith('python') || lang === 'py') {
      blocks.push({ lang: 'python', code });
    } else if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') {
      blocks.push({ lang: 'bash', code });
    }
  }
  return blocks;
}

/** If cmd is `llm "query"` or `llm 'query'`, return the query string; else null. */
export function parseLlmCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  const m = trimmed.match(/^llm\s+["']([^"']+)["']\s*$/s);
  return m ? m[1].trim() : null;
}
