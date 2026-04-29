import type { ProcessManager } from '../process/manager.js';
import type { SpawnOptions, SpawnResult } from '../process/process.js';

/**
 * PythonRunner delegates Python execution to a RustPython WASI binary
 * via ProcessManager. Supports:
 *   python3 -c "code"
 *   python3 script.py [args...]
 *   stdin piping (cat data | python3 -c "...")
 */
export class PythonRunner {
  private mgr: ProcessManager;

  constructor(mgr: ProcessManager) {
    this.mgr = mgr;
  }

  async run(opts: SpawnOptions): Promise<SpawnResult> {
    return this.mgr.spawn('python3', opts);
  }
}
