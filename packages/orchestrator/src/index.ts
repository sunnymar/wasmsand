// @wasmsand/sandbox - WASM AI Sandbox
export { VFS } from './vfs/vfs.js';
export type { VfsOptions } from './vfs/vfs.js';
export { ProcessManager } from './process/manager.js';
export { ShellRunner } from './shell/shell-runner.js';
export { PythonRunner } from './python/python-runner.js';
export { Sandbox } from './sandbox.js';
export type { SandboxOptions } from './sandbox.js';
export { BrowserAdapter } from './platform/browser-adapter.js';
// NodeAdapter not re-exported — imports node:fs/promises which breaks browser bundlers.
// Node consumers: import { NodeAdapter } from '@wasmsand/sandbox/node'
export type { PlatformAdapter } from './platform/adapter.js';
export type { SpawnOptions, SpawnResult } from './process/process.js';
export type { RunResult } from './shell/shell-runner.js';
export { NetworkGateway, NetworkAccessDenied } from './network/gateway.js';
export type { NetworkPolicy } from './network/gateway.js';
export { NetworkBridge } from './network/bridge.js';
export type { SyncFetchResult } from './network/bridge.js';
export type { SecurityOptions, SecurityLimits, ErrorClass, AuditEvent, AuditEventHandler } from './security.js';
export { CancelledError } from './security.js';
export type { VfsLike } from './vfs/vfs-like.js';
export { WorkerExecutor } from './execution/worker-executor.js';
export type { WorkerConfig, WorkerRunResult } from './execution/worker-executor.js';
export type { VirtualProvider } from './vfs/provider.js';
export { DevProvider } from './vfs/dev-provider.js';
export { ProcProvider } from './vfs/proc-provider.js';
export { PackageManager, PkgError } from './pkg/manager.js';
export type { PackageInfo } from './pkg/manager.js';
export type { PackagePolicy } from './security.js';
export type { PersistenceOptions } from './persistence/types.js';
export { exportState, importState } from './persistence/serializer.js';
export { CommandHistory } from './shell/history.js';
export type { HistoryEntry } from './shell/history.js';
