export interface PackageMetadata {
  name: string;
  version: string;
  summary: string;
  dependencies: string[];
  /** Map of relative path -> file content, e.g. { 'numpy/__init__.py': '...' } */
  pythonFiles: Record<string, string>;
  /** If true, requires a native module compiled into python3.wasm */
  native: boolean;
}
