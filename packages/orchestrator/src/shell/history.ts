/**
 * Command history tracking for ShellRunner.
 *
 * Records executed commands with sequential indices and timestamps,
 * accessible via the `history` shell builtin and public API methods.
 */

export interface HistoryEntry {
  index: number;
  command: string;
  timestamp: number;
}

export class CommandHistory {
  private entries: HistoryEntry[] = [];
  private nextIndex = 1;

  add(command: string): void {
    this.entries.push({ index: this.nextIndex++, command, timestamp: Date.now() });
  }

  list(): HistoryEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}
