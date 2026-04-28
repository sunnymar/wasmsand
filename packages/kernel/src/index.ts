// @codepod/kernel - WASM AI Sandbox
export { VFS } from './vfs/vfs.js';
export type { VfsOptions } from './vfs/vfs.js';
export { ProcessManager } from './process/manager.js';
export { PythonRunner } from './python/python-runner.js';
export { Sandbox } from './sandbox.js';
export type { SandboxOptions, MountConfig, StorageCallbacks, CommandExecutor } from './sandbox.js';
export type { KernelApi, KernelApiMemory, KernelApiProcessManager, KernelApiTime } from './kernel-api.js';
export type { RunCommandContext, RunCommandHandler, RunRequest, RunResponse } from './run-command.js';
export { BrowserAdapter } from './platform/browser-adapter.js';
// NodeAdapter not re-exported — imports node:fs/promises which breaks browser bundlers.
// Node consumers: import { NodeAdapter } from '@codepod/kernel/node'
export type { PlatformAdapter } from './platform/adapter.js';
export type { SpawnOptions, SpawnResult } from './process/process.js';
export type { RunResult } from './run-result.js';
export { NetworkGateway, NetworkAccessDenied } from './network/gateway.js';
export type { NetworkPolicy } from './network/gateway.js';
export { NetworkBridge } from './network/bridge.js';
export { BrowserNetworkBridge } from './network/browser-bridge.js';
export type { SyncFetchResult } from './network/bridge.js';
export type { SecurityOptions, SecurityLimits, ErrorClass, AuditEvent, AuditEventHandler } from './security.js';
export { CancelledError } from './security.js';
export type { VfsLike } from './vfs/vfs-like.js';
export type { VirtualProvider } from './vfs/provider.js';
export { HostMount } from './vfs/host-mount.js';
export type { HostMountOptions } from './vfs/host-mount.js';
export { DevProvider } from './vfs/dev-provider.js';
export { ProcProvider } from './vfs/proc-provider.js';
export { PackageManager, PkgError } from './pkg/manager.js';
export type { PackageInfo } from './pkg/manager.js';
export type { PackagePolicy } from './security.js';
export type { PersistenceOptions } from './persistence/types.js';
export type { PersistenceBackend } from './persistence/backend.js';
export { MemoryBackend } from './persistence/backend.js';
export { IdbBackend } from './persistence/idb-backend.js';
export { PersistenceManager } from './persistence/manager.js';
export type { PersistenceManagerOptions } from './persistence/manager.js';
export { exportState, importState } from './persistence/serializer.js';
// FsBackend not re-exported — imports node:fs which breaks browser bundlers.
// Node consumers: import { FsBackend } from '@codepod/kernel/node'
export type { ExtensionConfig, ExtensionHandler, ExtensionInvokeArgs, ExtensionInvokeResult, PythonPackageSpec } from './extension/types.js';
export { ExtensionRegistry } from './extension/registry.js';
export { SandboxPool } from './pool/sandbox-pool.js';
export type { PoolConfig, CheckoutOptions } from './pool/types.js';
