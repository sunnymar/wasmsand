import { Sandbox, BrowserAdapter } from '@codepod/kernel';

declare global {
  interface Window {
    __sandbox: Sandbox | null;
    __sandboxReady: boolean;
    __sandboxError: string | null;
  }
}

window.__sandbox = null;
window.__sandboxReady = false;
window.__sandboxError = null;

Sandbox.create({
  wasmDir: '',            // publicDir serves WASM files at root; '' → /echo.wasm (not //echo.wasm)
  adapter: new BrowserAdapter(),
}).then(sb => {
  window.__sandbox = sb;
  window.__sandboxReady = true;
  document.getElementById('status')!.textContent = 'ready';
}).catch(err => {
  window.__sandboxError = String(err);
  window.__sandboxReady = true;
  document.getElementById('status')!.textContent = 'error: ' + err;
});
