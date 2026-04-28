import type { RunCommandHandler, RunResponse } from '../../orchestrator/src/run-command.ts';
import { bashBootImports } from './bash-host-imports.js';

const RUN_COMMAND_METADATA_CAP = 1024 * 1024;

interface ProcessLike {
  readonly memory: WebAssembly.Memory;
  readonly exports: Record<string, (...args: number[]) => unknown>;
  callExport(name: string, ...args: number[]): Promise<number>;
  fdReadAndClear(fd: 1 | 2): { data: string; truncated: boolean };
  setStdin?(data: Uint8Array | undefined): void;
  terminate(): Promise<void>;
}

interface SandboxLike {
  process(pid: number): ProcessLike | undefined;
  getEnvMap?(): Map<string, string>;
  setEnvMap?(env: Map<string, string>): void;
  spawn(argv: string[], opts: {
    mode: 'resident' | 'cli';
    bootImports?: (api: Parameters<typeof bashBootImports>[0]) => Record<string, WebAssembly.ImportValue>;
  }): Promise<ProcessLike>;
}

export interface BashRunOptions {
  stdin?: string;
}

export interface BashRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  env?: Record<string, string>;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
}

export async function callRunCommand(
  proc: ProcessLike,
  cmd: string,
  opts?: BashRunOptions,
): Promise<BashRunResult> {
  const memory = proc.memory;
  const alloc = proc.exports.__alloc as ((size: number) => number) | undefined;
  const dealloc = proc.exports.__dealloc as ((ptr: number, size: number) => void) | undefined;
  if (!alloc || !dealloc) {
    throw new Error('process does not export __alloc/__dealloc');
  }

  const encoder = new TextEncoder();
  const stdin = opts?.stdin ? encoder.encode(opts.stdin) : undefined;
  if (stdin && !proc.setStdin) {
    throw new Error('process does not support stdin binding');
  }
  proc.setStdin?.(stdin);

  const cmdBytes = encoder.encode(cmd);
  const cmdPtr = alloc(cmdBytes.length);
  new Uint8Array(memory.buffer, cmdPtr, cmdBytes.length).set(cmdBytes);

  const outCap = RUN_COMMAND_METADATA_CAP;
  const outPtr = alloc(outCap);
  let decoded = '';
  try {
    const written = await proc.callExport('__run_command', cmdPtr, cmdBytes.length, outPtr, outCap);
    if (written > outCap) {
      throw new Error(`__run_command metadata exceeded ${outCap} bytes`);
    }
    decoded = new TextDecoder().decode(new Uint8Array(memory.buffer, outPtr, written));
  } finally {
    proc.setStdin?.(undefined);
    dealloc(cmdPtr, cmdBytes.length);
    dealloc(outPtr, outCap);
  }

  let parsed: { exit_code?: number; execution_time_ms?: number; env?: Record<string, string> };
  try {
    parsed = JSON.parse(decoded);
  } catch {
    parsed = { exit_code: 0, execution_time_ms: 0 };
  }

  const stdout = proc.fdReadAndClear(1);
  const stderr = proc.fdReadAndClear(2);
  const truncated = stdout.truncated || stderr.truncated
    ? { stdout: stdout.truncated, stderr: stderr.truncated }
    : undefined;

  return {
    exitCode: parsed.exit_code ?? 0,
    stdout: stdout.data,
    stderr: stderr.data,
    executionTimeMs: parsed.execution_time_ms ?? 0,
    ...(parsed.env ? { env: parsed.env } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

export async function runCommand(
  sandbox: Pick<SandboxLike, 'process' | 'getEnvMap' | 'setEnvMap'>,
  cmd: string,
  opts?: BashRunOptions,
): Promise<BashRunResult> {
  const proc = sandbox.process(1) as ProcessLike | undefined;
  if (!proc) throw new Error('PID 1 is not running');
  const envPrefix = buildEnvPrefix(sandbox.getEnvMap?.());
  const result = await callRunCommand(proc, envPrefix ? `${envPrefix}; ${cmd}` : cmd, opts);
  if (result.env && sandbox.setEnvMap) {
    sandbox.setEnvMap(new Map(Object.entries(result.env)));
  }
  return result;
}

function buildEnvPrefix(env: Map<string, string> | undefined): string {
  if (!env || env.size === 0) return '';
  const exports: string[] = [];
  for (const [name, value] of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    exports.push(`export ${name}='${value.replace(/'/g, "'\\''")}'`);
  }
  return exports.join('; ');
}

export function makeRunCommandHandler(): RunCommandHandler {
  return async (req, ctx): Promise<RunResponse> => {
    const child = await ctx.sandbox.spawn(['/bin/bash'], {
      mode: 'resident',
      bootImports: (api) => bashBootImports(api),
    }) as ProcessLike;
    try {
      const result = await callRunCommand(child as ProcessLike, req.cmd, { stdin: req.stdin });
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      await child.terminate();
    }
  };
}
