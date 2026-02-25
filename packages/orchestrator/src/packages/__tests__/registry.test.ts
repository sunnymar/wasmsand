import { describe, it, expect } from 'bun:test';
import { PackageRegistry } from '../registry';

describe('PackageRegistry', () => {
  it('lists available packages', () => {
    const reg = new PackageRegistry();
    const names = reg.available();
    expect(names).toBeInstanceOf(Array);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('requests');
  });

  it('returns metadata for a known package', () => {
    const reg = new PackageRegistry();
    const meta = reg.get('requests');
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('requests');
    expect(meta!.version).toBeDefined();
    expect(meta!.pythonFiles).toBeDefined();
    expect(Object.keys(meta!.pythonFiles).length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown package', () => {
    const reg = new PackageRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('resolves dependencies', () => {
    const reg = new PackageRegistry();
    const deps = reg.resolveDeps('pandas');
    expect(deps).toContain('numpy');
    expect(deps).toContain('pandas');
  });

  it('resolves packages with no deps to just themselves', () => {
    const reg = new PackageRegistry();
    const deps = reg.resolveDeps('requests');
    expect(deps).toEqual(['requests']);
  });
});
