import {
  Monty,
  MontySnapshot,
  MontySyntaxError,
  MontyRuntimeError,
} from '@pydantic/monty';
import type { VFS } from '../vfs/vfs.js';
import type { SpawnOptions, SpawnResult } from '../process/process.js';

const EXTERNAL_FUNCTIONS = [
  'read_file',
  'write_file',
  'list_dir',
  'file_exists',
  'read_stdin',
];

export class PythonRunner {
  private vfs: VFS;

  constructor(vfs: VFS) {
    this.vfs = vfs;
  }

  async run(opts: SpawnOptions): Promise<SpawnResult> {
    const startTime = performance.now();

    // Extract code from args
    const code = this.extractCode(opts.args);
    if (code === null) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'python3: missing -c or script argument\n',
        executionTimeMs: performance.now() - startTime,
      };
    }

    // Capture stdout/stderr
    let stdout = '';
    let stderr = '';
    const printCallback = (stream: string, text: string) => {
      if (stream === 'stderr') {
        stderr += text;
      } else {
        stdout += text;
      }
    };

    try {
      const monty = new Monty(code, { externalFunctions: EXTERNAL_FUNCTIONS });
      let progress = monty.start({
        printCallback,
        limits: {
          maxDurationSecs: 5,
          maxAllocations: 1_000_000,
          maxMemory: 64 * 1024 * 1024, // 64MB
          maxRecursionDepth: 500,
        },
      });

      while (progress instanceof MontySnapshot) {
        const fnName = progress.functionName;
        const fnArgs = progress.args;

        try {
          const returnValue = this.handleExternalCall(fnName, fnArgs, opts);
          progress = progress.resume({ returnValue });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          progress = progress.resume({
            exception: { type: 'OSError', message: msg },
          });
        }
      }

      return {
        exitCode: 0,
        stdout,
        stderr,
        executionTimeMs: performance.now() - startTime,
      };
    } catch (err) {
      if (err instanceof MontySyntaxError) {
        return {
          exitCode: 2,
          stdout,
          stderr: err.display('traceback') + '\n',
          executionTimeMs: performance.now() - startTime,
        };
      }
      if (err instanceof MontyRuntimeError) {
        return {
          exitCode: 1,
          stdout,
          stderr: err.display('traceback') + '\n',
          executionTimeMs: performance.now() - startTime,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        stdout,
        stderr: msg + '\n',
        executionTimeMs: performance.now() - startTime,
      };
    }
  }

  private handleExternalCall(
    name: string,
    args: unknown[],
    opts: SpawnOptions,
  ): unknown {
    switch (name) {
      case 'read_file': {
        const path = String(args[0]);
        const data = this.vfs.readFile(path);
        return new TextDecoder().decode(data);
      }
      case 'write_file': {
        const path = String(args[0]);
        const content = String(args[1]);
        this.vfs.writeFile(path, new TextEncoder().encode(content));
        return null;
      }
      case 'list_dir': {
        const path = String(args[0]);
        return this.vfs.readdir(path);
      }
      case 'file_exists': {
        const path = String(args[0]);
        try {
          this.vfs.stat(path);
          return true;
        } catch {
          return false;
        }
      }
      case 'read_stdin': {
        if (opts.stdinData) {
          return new TextDecoder().decode(opts.stdinData);
        }
        return '';
      }
      default:
        throw new Error(`Unknown external function: ${name}`);
    }
  }

  private extractCode(args: string[]): string | null {
    // python3 -c "code"
    const cIndex = args.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < args.length) {
      return args[cIndex + 1];
    }

    // python3 script.py — read from VFS
    const scriptArg = args.find(
      a => a.endsWith('.py') || (!a.startsWith('-') && a !== 'python3'),
    );
    if (scriptArg) {
      try {
        const data = this.vfs.readFile(scriptArg);
        return new TextDecoder().decode(data);
      } catch {
        return null;
      }
    }

    return null;
  }
}
