import type { ThreadsBackend } from './backend.js';
import type { IndirectCallTable } from './indirect-call-table.js';
import { NULL_INDIRECT_CALL_TABLE } from './indirect-call-table.js';

interface SpawnSlot {
  result: Promise<number>;
  reaped: boolean;
  detached: boolean;
}

export class CooperativeSerialBackend implements ThreadsBackend {
  readonly kind = 'cooperative-serial' as const;

  private slots: SpawnSlot[] = [];
  private indirectTable: IndirectCallTable = NULL_INDIRECT_CALL_TABLE;
  private activeTid = 0;

  setIndirectCallTable(table: IndirectCallTable): void {
    this.indirectTable = table;
    if (this.slots.length === 0) {
      this.slots.push({ result: Promise.resolve(0), reaped: true, detached: false });
    }
  }

  async spawn(fnPtr: number, arg: number): Promise<number> {
    if (this.slots.length === 0) {
      this.slots.push({ result: Promise.resolve(0), reaped: true, detached: false });
    }
    const tid = this.slots.length;
    const slot: SpawnSlot = { result: Promise.resolve(-1), reaped: false, detached: false };
    this.slots.push(slot);
    const result = (async () => {
      const previousTid = this.activeTid;
      this.activeTid = tid;
      try {
        return await this.indirectTable.call(fnPtr, arg);
      } finally {
        this.activeTid = previousTid;
      }
    })();
    slot.result = result;
    try {
      await result;
    } catch {
      return -1;
    }
    return tid;
  }

  async join(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped || slot.detached) return -1;
    slot.reaped = true;
    return await slot.result;
  }

  async detach(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped) return -1;
    slot.detached = true;
    slot.reaped = true;
    return 0;
  }

  self(): number {
    return this.activeTid;
  }

  async yield_(): Promise<number> {
    return 0;
  }

  async mutexLock(_mutexPtr: number): Promise<number> {
    return 0;
  }

  mutexUnlock(_mutexPtr: number): number {
    return 0;
  }

  mutexTryLock(_mutexPtr: number): number {
    return 0;
  }

  async condWait(_condPtr: number, _mutexPtr: number): Promise<number> {
    return 0;
  }

  condSignal(_condPtr: number): number {
    return 0;
  }

  condBroadcast(_condPtr: number): number {
    return 0;
  }
}
