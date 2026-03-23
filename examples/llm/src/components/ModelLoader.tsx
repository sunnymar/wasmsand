interface ModelLoaderProps {
  progress: number; // 0–1
  text: string;
  crossOriginIsolated: boolean;
}

export function ModelLoader({ progress, text, crossOriginIsolated }: ModelLoaderProps) {
  const pct = Math.round(progress * 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '1rem', color: '#cdd6f4', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 600, color: '#cba6f7' }}>codepod — LLM demo</div>
      <div style={{ width: 320, background: '#313244', borderRadius: 6, overflow: 'hidden', height: 8 }}>
        <div style={{ width: `${pct}%`, background: '#cba6f7', height: '100%', transition: 'width 0.3s ease' }} />
      </div>
      <div style={{ fontSize: '0.85rem', color: '#a6adc8', maxWidth: 320, textAlign: 'center' }}>{text || 'Initialising…'}</div>
      {pct === 0 && (
        <div style={{ fontSize: '0.75rem', color: '#6c7086', maxWidth: 320, textAlign: 'center' }}>
          First load downloads ~4 GB of model weights — cached in your browser after that.
        </div>
      )}
      {text.includes('Finish loading') && (
        <div style={{ fontSize: '0.75rem', color: '#f9e2af', maxWidth: 320, textAlign: 'center' }}>
          Compiling GPU shaders — one-time cost, a few minutes on first run.
        </div>
      )}
      {!crossOriginIsolated && (
        <div style={{ fontSize: '0.75rem', color: '#f38ba8', maxWidth: 320, textAlign: 'center' }}>
          ⚠ Not cross-origin isolated — sandbox may not work. Try a hard reload (Ctrl+Shift+R).
        </div>
      )}
    </div>
  );
}
