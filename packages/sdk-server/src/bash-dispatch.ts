import type { RunCommandHandler, RunResponse } from '../../orchestrator/src/run-command.ts';
import { bashBootImports } from './bash-host-imports.js';

interface ProcessLike {
  readonly memory: WebAssembly.Memory;
  readonly exports: Record<string, (...args: number[]) => unknown>;
  callExport(name: string, ...args: number[]): Promise<number>;
  fdReadAndClear(fd: 1 | 2): { data: string; truncated: boolean };
  terminate(): Promise<void>;
}

interface SandboxLike {
  process(pid: number): ProcessLike | undefined;
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
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
}

export async function callRunCommand(
  proc: ProcessLike,
  cmd: string,
  _opts?: BashRunOptions,
): Promise<BashRunResult> {
  const memory = proc.memory;
  const alloc = proc.exports.__alloc as ((size: number) => number) | undefined;
  const dealloc = proc.exports.__dealloc as ((ptr: number, size: number) => void) | undefined;
  if (!alloc || !dealloc) {
    throw new Error('process does not export __alloc/__dealloc');
  }

  const cmdBytes = new TextEncoder().encode(cmd);
  const cmdPtr = alloc(cmdBytes.length);
  new Uint8Array(memory.buffer, cmdPtr, cmdBytes.length).set(cmdBytes);

  let outCap = 4096;
  let outPtr = alloc(outCap);
  let written = await proc.callExport('__run_command', cmdPtr, cmdBytes.length, outPtr, outCap);
  if (written > outCap) {
    dealloc(outPtr, outCap);
    outCap = written;
    outPtr = alloc(outCap);
    written = await proc.callExport('__run_command', cmdPtr, cmdBytes.length, outPtr, outCap);
  }

  const decoded = new TextDecoder().decode(new Uint8Array(memory.buffer, outPtr, written));
  dealloc(cmdPtr, cmdBytes.length);
  dealloc(outPtr, outCap);

  let parsed: { exit_code?: number; execution_time_ms?: number };
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
    ...(truncated ? { truncated } : {}),
  };
}

export async function runCommand(
  sandbox: Pick<SandboxLike, 'process'>,
  cmd: string,
  opts?: BashRunOptions,
): Promise<BashRunResult> {
  const proc = sandbox.process(1) as ProcessLike | undefined;
  if (!proc) throw new Error('PID 1 is not running');
  return callRunCommand(proc, cmd, opts);
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
