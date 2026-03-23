/** A single fragment in an assistant turn, rendered in order. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; callId: string; command: string }
  | { kind: 'tool-result'; callId: string; stdout: string; stderr: string; exitCode: number };

/** A message in the conversation history. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  /** User or assistant text (for display). Parts list for assistant turns. */
  content: string;
  parts?: Part[];
  /** Unique ID for keying React elements. */
  id: string;
}

export type BootState =
  | { phase: 'booting'; modelProgress: number; modelText: string; crossOriginIsolated: boolean }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };
