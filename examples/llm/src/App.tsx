import { useState, useEffect, useRef } from 'react';
import type { BootState } from './types.js';
import { initSandbox } from './sandbox.js';
import { initEngine } from './llm.js';
import { ModelLoader } from './components/ModelLoader.js';
import { Chat } from './components/Chat.js';
import type { Sandbox } from '@codepod/sandbox';

export function App() {
  const [boot, setBoot] = useState<BootState>({ phase: 'booting', modelProgress: 0, modelText: '', crossOriginIsolated: window.crossOriginIsolated });
  const [sandboxReady, setSandboxReady] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const sandboxRef = useRef<Sandbox | null>(null);
  const engineRef = useRef<unknown>(null);

  useEffect(() => {
    let cancelled = false;

    async function startBoot() {
      try {
        const coi = window.crossOriginIsolated;
        console.log('[boot] crossOriginIsolated:', coi);

        // Check WebGPU availability upfront
        if (!('gpu' in navigator)) {
          setBoot({ phase: 'error', message: 'WebGPU is not available. This demo requires Chrome 113+.' });
          return;
        }

        // Kick off sandbox in the background — don't block model loading on it
        initSandbox().then(sandbox => {
          if (!cancelled) {
            sandboxRef.current = sandbox;
            setSandboxReady(true);
            console.log('[boot] sandbox ready');
          }
        }).catch(err => {
          console.error('[boot] sandbox init failed:', err);
        });

        // Wait only for the engine before showing chat
        const engine = await initEngine((progress, text) => {
          if (!cancelled) setBoot({ phase: 'booting', modelProgress: progress, modelText: text, crossOriginIsolated: coi });
        });

        if (cancelled) return;
        engineRef.current = engine;
        setBoot({ phase: 'ready' });
      } catch (err) {
        if (!cancelled) {
          setBoot({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    startBoot();
    return () => { cancelled = true; };
  }, [retryKey]);

  if (boot.phase === 'booting') {
    return <ModelLoader progress={boot.modelProgress} text={boot.modelText} crossOriginIsolated={boot.crossOriginIsolated} />;
  }

  if (boot.phase === 'error') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1e1e2e', color: '#f38ba8', fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: '2rem' }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>Failed to start</div>
          <div style={{ color: '#a6adc8', fontSize: '0.9rem', marginBottom: '1rem' }}>{boot.message}</div>
          <button
            onClick={() => { sandboxRef.current = null; engineRef.current = null; setSandboxReady(false); setBoot({ phase: 'booting', modelProgress: 0, modelText: '', crossOriginIsolated: window.crossOriginIsolated }); setRetryKey(k => k + 1); }}
            style={{ padding: '0.4rem 1rem', background: '#cba6f7', color: '#1e1e2e', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <Chat engine={engineRef.current} sandbox={sandboxRef.current} sandboxReady={sandboxReady} />;
}
