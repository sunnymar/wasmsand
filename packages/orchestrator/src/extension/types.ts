export interface ExtensionInvokeArgs {
  args: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
}

export interface ExtensionInvokeResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export type ExtensionHandler =
  (input: ExtensionInvokeArgs) => Promise<ExtensionInvokeResult>;

export interface PythonPackageSpec {
  version: string;
  summary?: string;
  files: Record<string, string>; // relative path → Python source
}

export interface ExtensionConfig {
  name: string;
  description?: string;
  command?: ExtensionHandler;
  pythonPackage?: PythonPackageSpec;
}
