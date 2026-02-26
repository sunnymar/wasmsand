import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ShellRunner } from '../../orchestrator/src/shell/shell-runner.js';

const PROMPT = '$ ';

export function createTerminal(
  container: HTMLElement,
  runner: ShellRunner,
): Terminal {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b7066',
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  window.addEventListener('resize', () => fit.fit());

  let currentLine = '';
  let running = false;
  const history: string[] = [];
  let historyIndex = -1;

  function prompt(): void {
    term.write(PROMPT);
  }

  function printBanner(): void {
    term.writeln('codepod — WebAssembly sandbox shell');
    term.writeln('Try: for i in 1 2 3; do echo "hello $i"; done');
    term.writeln('     case $USER in u*) echo "matched";; esac');
    term.writeln('     python3 -c "print(1+1)"');
    term.writeln('');
  }

  printBanner();
  prompt();

  term.onKey(async ({ key, domEvent }) => {
    if (running) return;

    const code = domEvent.keyCode;

    // Enter
    if (code === 13) {
      term.writeln('');
      const line = currentLine.trim();
      currentLine = '';
      historyIndex = -1;

      if (line === '') {
        prompt();
        return;
      }

      history.push(line);
      running = true;

      try {
        const result = await runner.run(line);

        if (result.stdout) {
          // Ensure \n renders as \r\n for xterm
          term.write(result.stdout.replace(/\n/g, '\r\n'));
        }
        if (result.stderr) {
          term.write(`\x1b[31m${result.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        term.writeln(`\x1b[31mError: ${msg}\x1b[0m`);
      }

      running = false;
      prompt();
      return;
    }

    // Backspace
    if (code === 8) {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }

    // Ctrl+C
    if (domEvent.ctrlKey && code === 67) {
      currentLine = '';
      term.writeln('^C');
      prompt();
      return;
    }

    // Ctrl+L (clear)
    if (domEvent.ctrlKey && code === 76) {
      term.clear();
      prompt();
      term.write(currentLine);
      return;
    }

    // Up arrow (history)
    if (code === 38) {
      if (history.length > 0) {
        if (historyIndex === -1) historyIndex = history.length;
        if (historyIndex > 0) {
          historyIndex--;
          // Clear current line
          term.write('\r' + PROMPT + ' '.repeat(currentLine.length) + '\r' + PROMPT);
          currentLine = history[historyIndex];
          term.write(currentLine);
        }
      }
      return;
    }

    // Down arrow (history)
    if (code === 40) {
      if (historyIndex !== -1) {
        historyIndex++;
        term.write('\r' + PROMPT + ' '.repeat(currentLine.length) + '\r' + PROMPT);
        if (historyIndex >= history.length) {
          historyIndex = -1;
          currentLine = '';
        } else {
          currentLine = history[historyIndex];
          term.write(currentLine);
        }
      }
      return;
    }

    // Regular printable character
    if (key.length === 1 && !domEvent.ctrlKey && !domEvent.altKey && !domEvent.metaKey) {
      currentLine += key;
      term.write(key);
    }
  });

  return term;
}
