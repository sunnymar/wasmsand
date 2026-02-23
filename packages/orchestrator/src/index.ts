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
