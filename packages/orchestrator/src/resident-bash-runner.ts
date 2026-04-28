import type { ProcessManager } from './process/manager.js';
import type { LoaderContext } from './process/loader.js';
import type { ResidentCommandRunner } from './command-runner.js';
import { ShellInstance, type ShellInstanceOptions } from './shell/shell-instance.js';

export type ResidentBashRunnerOptions = ShellInstanceOptions;

export function createResidentBashRunner(
  loaderCtx: LoaderContext,
  mgr: ProcessManager,
  wasmPath: string,
  options?: ResidentBashRunnerOptions,
): Promise<ResidentCommandRunner> {
  return ShellInstance.createWithLoader(loaderCtx, mgr, wasmPath, options);
}
