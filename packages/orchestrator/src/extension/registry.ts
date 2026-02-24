import type { ExtensionConfig, ExtensionInvokeArgs, ExtensionInvokeResult } from './types.js';

export class ExtensionRegistry {
  private extensions = new Map<string, ExtensionConfig>();

  register(ext: ExtensionConfig): void {
    this.extensions.set(ext.name, ext);
  }

  get(name: string): ExtensionConfig | undefined {
    return this.extensions.get(name);
  }

  has(name: string): boolean {
    return this.extensions.has(name);
  }

  list(): ExtensionConfig[] {
    return Array.from(this.extensions.values());
  }

  getCommandNames(): string[] {
    return this.list()
      .filter((e) => e.command != null)
      .map((e) => e.name);
  }

  getPackageNames(): string[] {
    return this.list()
      .filter((e) => e.pythonPackage != null)
      .map((e) => e.name);
  }

  async invoke(name: string, input: ExtensionInvokeArgs): Promise<ExtensionInvokeResult> {
    const ext = this.extensions.get(name);
    if (!ext?.command) {
      throw new Error(`Extension "${name}" not found or has no command handler`);
    }
    return ext.command(input);
  }
}
