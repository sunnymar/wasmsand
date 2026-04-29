import { Sandbox } from '../sandbox.js';
import type { SandboxOptions } from '../sandbox.js';
import type { PoolConfig, CheckoutOptions } from './types.js';

export class SandboxPool {
  private readonly config: PoolConfig;
  private readonly sandboxOptions: SandboxOptions;
  private readonly idle: Sandbox[] = [];
  private creatingCount = 0;
  private checkedOutCount = 0;
  private replenishTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(config: PoolConfig, sandboxOptions: SandboxOptions) {
    this.config = config;
    this.sandboxOptions = sandboxOptions;
  }

  get stats() {
    return {
      idle: this.idle.length,
      creating: this.creatingCount,
      checkedOut: this.checkedOutCount,
    };
  }

  async init(): Promise<void> {
    // Create minSize sandboxes serially to avoid memory spikes
    for (let i = 0; i < this.config.minSize; i++) {
      if (this.draining) return;
      await this.createOne();
    }
    // Start periodic health check
    const interval = this.config.replenishIntervalMs ?? 1000;
    this.replenishTimer = setInterval(() => this.replenishIfNeeded(), interval);
  }

  private async createOne(): Promise<void> {
    const total = this.idle.length + this.creatingCount + this.checkedOutCount;
    if (total >= this.config.maxSize) return;
    this.creatingCount++;
    try {
      const sb = await Sandbox.create(this.sandboxOptions);
      if (this.draining) {
        sb.destroy();
      } else {
        this.idle.push(sb);
      }
    } finally {
      this.creatingCount--;
    }
  }

  private replenishIfNeeded(): void {
    if (this.draining) return;
    if (this.idle.length < this.config.minSize) {
      this.createOne().catch((err) => {
        console.error('[SandboxPool] replenish failed:', err);
      });
    }
  }

  async checkout(overrides?: CheckoutOptions): Promise<Sandbox> {
    if (this.draining) throw new Error('Pool is draining');

    // Increment synchronously to prevent maxSize races
    this.checkedOutCount++;

    let sb: Sandbox;
    try {
      if (this.idle.length > 0) {
        sb = this.idle.pop()!;
      } else {
        // Fallback: create on demand
        this.creatingCount++;
        try {
          sb = await Sandbox.create(this.sandboxOptions);
        } finally {
          this.creatingCount--;
        }
      }

      // Apply overrides
      if (overrides) {
        if (overrides.env) {
          for (const [k, v] of Object.entries(overrides.env)) {
            sb.setEnv(k, v);
          }
        }
        if (overrides.files) {
          for (const f of overrides.files) {
            sb.writeFile(f.path, f.content);
          }
        }
        if (overrides.mounts) {
          for (const mc of overrides.mounts) {
            sb.mount(mc.path, mc.files);
          }
        }
      }
    } catch (err) {
      this.checkedOutCount--;
      throw err;
    }

    // Trigger background replenish
    this.replenishIfNeeded();

    return sb;
  }

  release(sandbox: Sandbox): void {
    sandbox.destroy();
    this.checkedOutCount--;
    this.replenishIfNeeded();
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.replenishTimer !== null) {
      clearInterval(this.replenishTimer);
      this.replenishTimer = null;
    }
    for (const sb of this.idle) {
      sb.destroy();
    }
    this.idle.length = 0;
    // Wait for in-flight creates to complete (they will self-destroy
    // because this.draining is true)
    while (this.creatingCount > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
