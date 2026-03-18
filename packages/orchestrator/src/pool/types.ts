import type { MountConfig } from '../sandbox.js';
import type { NetworkPolicy } from '../network/gateway.js';
import type { ExtensionConfig } from '../extension/types.js';

export interface PoolConfig {
  /** Minimum idle sandboxes to maintain. */
  minSize: number;
  /** Cap on total sandboxes (idle + creating + checked out). */
  maxSize: number;
  /** Health-check interval in ms. Default 1000. */
  replenishIntervalMs?: number;
}

export interface CheckoutOptions {
  files?: Array<{ path: string; content: Uint8Array }>;
  env?: Record<string, string>;
  mounts?: MountConfig[];
  networkPolicy?: NetworkPolicy;
  label?: string;
  extensions?: ExtensionConfig[];
}
