import { useState, useRef, useEffect } from 'react';
import type { Part, ChatMessage } from '../types.js';
import { ToolCall } from './ToolCall.js';
import { runChat } from '../chat.js';
import type { Sandbox } from '@codepod/sandbox';
import { runBash } from '../sandbox.js';

interface ChatProps {
  engine: unknown; // MLCEngine — typed as unknown to avoid importing webllm types here
  sandbox: Sandbox | null;
  sandboxReady: boolean;
}

function renderParts(parts: Part[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.kind === 'text') {
      // Accumulate consecutive text parts
      let text = part.text;
      while (i + 1 < parts.length && parts[i + 1].kind === 'text') {
        i++;
        text += (parts[i] as { kind: 'text'; text: string }).text;
      }
      nodes.push(<span key={i} style={{ whiteSpace: 'pre-wrap' }}>{text}</span>);
    } else if (part.kind === 'tool-call') {
      const result = parts.find(
        (p, j) => j > i && p.kind === 'tool-result' && p.callId === part.callId,
      ) as Extract<Part, { kind: 'tool-result' }> | undefined;
      nodes.push(<ToolCall key={part.callId} call={part} result={result} />);
    }
    // tool-result is rendered inside ToolCall, skip standalone rendering
    i++;
  }
  return nodes;
}

export function Chat({ engine, sandbox, sandboxReady }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (!input.trim() || generating) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: input };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', parts: [] };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setGenerating(true);

    const history = [...messages, userMsg].map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    await runChat(
      engine as never,
      (cmd) => sandbox ? runBash(sandbox, cmd) : Promise.resolve({ stdout: '', stderr: 'Sandbox not ready yet — please wait and retry.', exitCode: 1 }),
      history,
      (part) => {
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          const parts = [...(m.parts ?? []), part];
          const text = parts.filter(p => p.kind === 'text').map(p => (p as { kind: 'text'; text: string }).text).join('');
          return { ...m, parts, content: text };
        }));
      },
    );

    setGenerating(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1e1e2e', color: '#cdd6f4', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #313244', color: '#cba6f7', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>codepod — LLM demo <span style={{ fontSize: '0.75rem', color: '#6c7086', fontWeight: 400 }}>(Llama 3.2 1B · WebGPU)</span></span>
        {!sandboxReady && <span style={{ fontSize: '0.72rem', color: '#f9e2af', fontWeight: 400 }}>sandbox loading…</span>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {messages.length === 0 && (
          <div style={{ color: '#6c7086', fontSize: '0.9rem', textAlign: 'center', marginTop: '2rem' }}>
            Ask me about the code in /src/, or give me a task to solve.
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: '0.25rem' }}>
            <div style={{ maxWidth: '80%', background: msg.role === 'user' ? '#313244' : '#181825', borderRadius: 8, padding: '0.5rem 0.75rem', border: '1px solid #313244' }}>
              {msg.role === 'assistant' && msg.parts ? renderParts(msg.parts) : msg.content}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #313244', display: 'flex', gap: '0.5rem' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          disabled={generating}
          placeholder={generating ? 'Generating…' : 'Ask anything…'}
          style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, padding: '0.5rem 0.75rem', color: '#cdd6f4', outline: 'none', fontSize: '0.9rem' }}
        />
        <button
          onClick={send}
          disabled={generating || !input.trim()}
          style={{ padding: '0.5rem 1rem', background: '#cba6f7', color: '#1e1e2e', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, opacity: generating ? 0.5 : 1 }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
