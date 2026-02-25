import type { PackageMetadata } from './types';

const PACKAGES: PackageMetadata[] = [
  {
    name: 'requests',
    version: '2.31.0',
    summary: 'HTTP library (wrapper over urllib.request)',
    dependencies: [],
    native: false,
    pythonFiles: {
      'requests/__init__.py': '__version__ = "2.31.0"\n# placeholder - real impl in Task 4\n',
    },
  },
  {
    name: 'numpy',
    version: '1.26.0',
    summary: 'Numerical computing (ndarray-backed)',
    dependencies: [],
    native: true,
    pythonFiles: {
      'numpy/__init__.py': '# placeholder - real impl in Task 6\n',
    },
  },
  {
    name: 'pandas',
    version: '2.1.0',
    summary: 'Data analysis (calamine + xlsxwriter backed)',
    dependencies: ['numpy'],
    native: true,
    pythonFiles: {
      'pandas/__init__.py': '# placeholder - real impl in Task 9\n',
    },
  },
  {
    name: 'PIL',
    version: '10.0.0',
    summary: 'Image processing (image crate-backed)',
    dependencies: [],
    native: true,
    pythonFiles: {
      'PIL/__init__.py': '# placeholder - real impl in Task 8\n',
    },
  },
  {
    name: 'matplotlib',
    version: '3.8.0',
    summary: 'Plotting (plotters + resvg backed)',
    dependencies: ['numpy'],
    native: true,
    pythonFiles: {
      'matplotlib/__init__.py': '# placeholder - real impl in Task 10\n',
    },
  },
  {
    name: 'sklearn',
    version: '1.3.0',
    summary: 'Machine learning (linfa-backed)',
    dependencies: ['numpy'],
    native: true,
    pythonFiles: {
      'sklearn/__init__.py': '# placeholder - real impl in Task 11\n',
    },
  },
  {
    name: 'sqlite3',
    version: '3.49.0',
    summary: 'SQLite database (C FFI backed)',
    dependencies: [],
    native: true,
    pythonFiles: {
      'sqlite3/__init__.py': '# placeholder - real impl in Task 7\n',
    },
  },
];

export class PackageRegistry {
  private packages = new Map<string, PackageMetadata>();

  constructor() {
    for (const pkg of PACKAGES) {
      this.packages.set(pkg.name, pkg);
    }
  }

  available(): string[] {
    return [...this.packages.keys()].sort();
  }

  get(name: string): PackageMetadata | undefined {
    return this.packages.get(name);
  }

  has(name: string): boolean {
    return this.packages.has(name);
  }

  /** Returns the package + all transitive dependencies, topologically sorted */
  resolveDeps(name: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visit = (n: string) => {
      if (visited.has(n)) return;
      visited.add(n);
      const pkg = this.packages.get(n);
      if (!pkg) return;
      for (const dep of pkg.dependencies) {
        visit(dep);
      }
      result.push(n);
    };
    visit(name);
    return result;
  }
}
