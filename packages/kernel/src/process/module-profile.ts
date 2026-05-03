export type CodepodBridgeKind = "asyncify" | "jspi" | "sync";

export interface CodepodModuleProfile {
  readonly importsSetjmp: boolean;
  readonly importsFork: boolean;
  readonly hasAsyncify: boolean;
  readonly hasContinuationsFeature: boolean;
  readonly hasLegacySetjmpFeature: boolean;
  readonly requiresContinuations: boolean;
  readonly bridge: CodepodBridgeKind;
}

export interface AnalyzeCodepodModuleOptions {
  readonly jspiAvailable?: boolean;
}

const ASYNCIFY_EXPORTS = [
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
  "asyncify_get_state",
] as const;

export function analyzeCodepodModule(
  module: WebAssembly.Module,
  opts: AnalyzeCodepodModuleOptions = {},
): CodepodModuleProfile {
  const imports = WebAssembly.Module.imports(module);
  const importsSetjmp = imports.some((imp) =>
    imp.module === "codepod" &&
    (imp.name === "host_setjmp" || imp.name === "host_longjmp")
  );
  const importsFork = imports.some((imp) =>
    imp.module === "codepod" && imp.name === "host_fork"
  );
  const hasAsyncify = moduleHasAsyncify(module);
  const hasContinuationsFeature = moduleHasCodepodFeature(module, "continuations");
  const hasLegacySetjmpFeature = moduleHasCodepodFeature(module, "setjmp");
  const requiresContinuations =
    importsFork ||
    hasContinuationsFeature ||
    hasLegacySetjmpFeature;
  const jspiAvailable = opts.jspiAvailable ??
    typeof WebAssembly.Suspending === "function";

  return {
    importsSetjmp,
    importsFork,
    hasAsyncify,
    hasContinuationsFeature,
    hasLegacySetjmpFeature,
    requiresContinuations,
    bridge: requiresContinuations ? "asyncify" : jspiAvailable ? "jspi" : "sync",
  };
}

export function validateCodepodModuleProfile(
  profile: CodepodModuleProfile,
): CodepodModuleProfile {
  if (profile.importsFork && !hasAnyContinuationFeature(profile)) {
    throw new Error(
      "module imports host_fork but lacks codepod.features continuations marker; rebuild with CPCC_USE_CONTINUATIONS=1",
    );
  }
  if (profile.requiresContinuations && !profile.hasAsyncify) {
    throw new Error(
      "module declares codepod.features continuations but is not asyncify-instrumented",
    );
  }
  return profile;
}

export function moduleHasAsyncify(module: WebAssembly.Module): boolean {
  const exports = WebAssembly.Module.exports(module);
  return ASYNCIFY_EXPORTS.every((name) =>
    exports.some((exp) => exp.kind === "function" && exp.name === name)
  );
}

export function moduleHasCodepodFeature(
  module: WebAssembly.Module,
  feature: string,
): boolean {
  for (
    const section of WebAssembly.Module.customSections(
      module,
      "codepod.features",
    )
  ) {
    try {
      const decoded = JSON.parse(new TextDecoder().decode(section)) as {
        features?: unknown;
      };
      if (Array.isArray(decoded.features) && decoded.features.includes(feature)) {
        return true;
      }
    } catch {
      // Malformed custom sections are ignored here; required-feature checks
      // still fail closed when the marker is absent.
    }
  }
  return false;
}

function hasAnyContinuationFeature(profile: CodepodModuleProfile): boolean {
  return profile.hasContinuationsFeature || profile.hasLegacySetjmpFeature;
}
