import { useState } from 'react';
import type { Part } from '../types.js';

interface ToolCallProps {
  call: Extract<Part, { kind: 'tool-call' }>;
  result?: Extract<Part, { kind: 'tool-result' }>;
}

export function ToolCall({ call, result }: ToolCallProps) {
  const [open, setOpen] = useState(false);
  const hasError = result && result.exitCode !== 0;

  return (
    <div style={{ margin: '0.4rem 0', border: '1px solid #313244', borderRadius: 6, overflow: 'hidden', fontSize: '0.82rem', fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', textAlign: 'left', padding: '0.4rem 0.6rem', background: '#1e1e2e', border: 'none', cursor: 'pointer', color: '#a6adc8', display: 'flex', gap: '0.5rem', alignItems: 'center' }}
      >
        <span style={{ color: '#89b4fa' }}>$</span>
        <span style={{ color: '#cdd6f4', flex: 1 }}>{call.command}</span>
        {result ? (
          <span style={{ color: hasError ? '#f38ba8' : '#a6e3a1' }}>{result.exitCode === 0 ? '✓' : `✗ ${result.exitCode}`}</span>
        ) : (
          <span style={{ color: '#f9e2af' }}>running…</span>
        )}
        <span style={{ color: '#6c7086' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && result && (
        <div style={{ padding: '0.4rem 0.6rem', background: '#181825', borderTop: '1px solid #313244' }}>
          {result.stdout && (
            <pre style={{ margin: 0, color: '#cdd6f4', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{result.stdout}</pre>
          )}
          {result.stderr && (
            <pre style={{ margin: 0, color: '#f38ba8', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{result.stderr}</pre>
          )}
        </div>
      )}
    </div>
  );
}
