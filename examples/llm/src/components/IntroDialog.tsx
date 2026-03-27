const STORAGE_KEY = 'codepod-rlm-intro-seen';

interface IntroDialogProps {
  onDismiss: () => void;
}

export function IntroDialog({ onDismiss }: IntroDialogProps) {
  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    onDismiss();
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: '1rem',
    }}>
      <div style={{
        background: '#181825',
        border: '1px solid #313244',
        borderRadius: 10,
        padding: '1.75rem',
        maxWidth: 520,
        width: '100%',
        color: '#cdd6f4',
        fontFamily: 'system-ui, sans-serif',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#cba6f7', marginBottom: '1rem' }}>
          Welcome to the Codepod RLM Demo
        </div>

        <p style={{ fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '0.85rem', color: '#a6adc8' }}>
          This is a live demo of{' '}
          <a href="https://github.com/codepod-sandbox/codepod" target="_blank" rel="noreferrer" style={{ color: '#89b4fa' }}>Codepod</a>
          {' '}— a browser-native sandbox environment — combined with the{' '}
          <a href="https://arxiv.org/abs/2505.00000" target="_blank" rel="noreferrer" style={{ color: '#89b4fa' }}>
            Recursive Language Model (RLM)
          </a>
          {' '}agentic pattern.
        </p>

        <p style={{ fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '0.85rem', color: '#a6adc8' }}>
          <strong style={{ color: '#cdd6f4' }}>Everything runs locally in your browser.</strong>{' '}
          The LLM is loaded via WebGPU (no server calls). The sandbox gives it a persistent bash shell and Python 3 environment — it can run code, install packages, and read files, all in-browser.
        </p>

        <p style={{ fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '0.85rem', color: '#a6adc8' }}>
          The RLM pattern lets the model spawn sub-agents via{' '}
          <code style={{ background: '#313244', borderRadius: 3, padding: '1px 5px', fontSize: '0.82rem', color: '#a6e3a1' }}>
            llm "question"
          </code>
          {' '}— a bash command that recursively invokes another LLM instance. Sub-agents can run their own code and return results to the parent.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.6rem 0.75rem', background: '#1e1e2e', borderRadius: 6, border: '1px solid #45475a', marginBottom: '1.25rem', fontSize: '0.82rem', color: '#6c7086' }}>
          <span style={{ color: '#f9e2af' }}>⚠</span>
          First load downloads the model weights (~1.7 GB for the default 3B model). Cached in your browser after that.
        </div>

        <button
          onClick={dismiss}
          style={{
            width: '100%', padding: '0.55rem 1rem',
            background: '#cba6f7', color: '#1e1e2e',
            border: 'none', borderRadius: 6,
            cursor: 'pointer', fontWeight: 700,
            fontSize: '0.95rem',
          }}
        >
          Let's go
        </button>
      </div>
    </div>
  );
}

export function shouldShowIntro(): boolean {
  return !localStorage.getItem(STORAGE_KEY);
}
